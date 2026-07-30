import { describe, expect, it, vi } from "vitest";
import {
  reconcileExternalOutcomeByOwner,
  updateTaskByOwnerWithAudit,
  type OwnerTaskUpdateResult,
} from "./db";
import {
  externalTaskApprovalFingerprint,
  externalTaskApprovalSourceFingerprint,
  type ExternalApprovalArtifact,
} from "./safety/externalTaskApproval";

type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_approval";

const approvalRequestId = "11111111-1111-4111-8111-111111111111";

function transactionHarness(
  initialStatus: TaskStatus,
  extraMetadata: Record<string, unknown> = {}
) {
  const baseTask = {
    id: 9,
    source: "manual",
    description: "Send an approved owner-reviewed update.",
    actionType: "send_sms",
    actionPayload: {
      phoneNumber: "+61400000000",
      message: "Approved update",
    },
    estimatedValue: "250",
    status: initialStatus,
    priorityScore: 50,
    completedAt: null as Date | null,
  };
  const artifact: ExternalApprovalArtifact = {
    version: 1,
    sourceFingerprint: externalTaskApprovalSourceFingerprint(baseTask),
    actionType: "send_sms",
    target: "+61400000000",
    content: "[Robur AI] Approved update",
    providerIdentity: {
      provider: "twilio",
      from: "+61411111111",
    },
  };
  const preparedTask = {
    ...baseTask,
    metadata: { external_approval_artifact: artifact, ...extraMetadata },
  };
  let task = {
    ...preparedTask,
    metadata: {
      ...preparedTask.metadata,
      external_approval_fingerprint:
        externalTaskApprovalFingerprint(preparedTask),
      external_approval_request_id: approvalRequestId,
    },
  };
  const audit: Array<Record<string, unknown>> = [];
  let failAuditInsert = false;
  let rowLockCount = 0;
  let updateCount = 0;
  let approvalBoundary:
    | Array<{ actionType: string; details: Record<string, unknown> }>
    | undefined;

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async (strength: string) => {
              expect(strength).toBe("update");
              rowLockCount += 1;
              return task ? [{ ...task }] : [];
            },
          }),
          orderBy: () => ({
            limit: async () =>
              approvalBoundary ?? [
                {
                  actionType: "external_contact_approval_request",
                  details: {
                    approvalFingerprint:
                      externalTaskApprovalFingerprint(task),
                    approvalRequestId,
                    presentationMode: "sms_full",
                    notificationSent: true,
                  },
                },
              ],
          }),
        }),
      }),
    }),
    update: () => ({
      set: (data: Partial<typeof task>) => ({
        where: async () => {
          updateCount += 1;
          task = { ...task, ...data };
          return [{ affectedRows: 1 }];
        },
      }),
    }),
    insert: () => ({
      values: async (entry: Record<string, unknown>) => {
        if (failAuditInsert) {
          throw new Error("simulated audit insert failure");
        }
        audit.push(entry);
        return [{ insertId: audit.length }];
      },
    }),
  };

  const database = {
    transaction: async (
      callback: (value: typeof tx) => Promise<OwnerTaskUpdateResult>
    ) => {
      const taskBefore = { ...task };
      const auditBefore = audit.map(entry => ({ ...entry }));
      try {
        return await callback(tx);
      } catch (error) {
        task = taskBefore;
        audit.splice(0, audit.length, ...auditBefore);
        throw error;
      }
    },
  };

  return {
    database,
    audit,
    get task() {
      return task;
    },
    get rowLockCount() {
      return rowLockCount;
    },
    get updateCount() {
      return updateCount;
    },
    failNextAuditInsert() {
      failAuditInsert = true;
    },
    setApprovalBoundary(
      entries: Array<{
        actionType: string;
        details: Record<string, unknown>;
      }>
    ) {
      approvalBoundary = entries;
    },
  };
}

describe("atomic owner task update", () => {
  it("locks the task and commits the status change with its audit event", async () => {
    const harness = transactionHarness("pending");

    const result = await updateTaskByOwnerWithAudit(
      9,
      { status: "failed", expectedStatus: "pending" },
      harness.database as never
    );

    expect(result).toEqual({
      outcome: "updated",
      previousStatus: "pending",
      nextStatus: "failed",
      statusChanged: true,
    });
    expect(harness.rowLockCount).toBe(1);
    expect(harness.task.status).toBe("failed");
    expect(harness.task.completedAt).toBeInstanceOf(Date);
    expect(harness.audit).toEqual([
      {
        taskId: 9,
        actionType: "owner_task_status_update",
        details: {
          previousStatus: "pending",
          nextStatus: "failed",
          actor: "verified_owner",
        },
        outcome: "failure",
      },
    ]);
  });

  it("treats a same-status replay as idempotent", async () => {
    const harness = transactionHarness("completed");

    const first = await updateTaskByOwnerWithAudit(
      9,
      { status: "completed" },
      harness.database as never
    );
    const second = await updateTaskByOwnerWithAudit(
      9,
      { status: "completed" },
      harness.database as never
    );

    expect(first.statusChanged).toBe(false);
    expect(second.statusChanged).toBe(false);
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });

  it("does not let an owner recycle a completed external task through a stale approval", async () => {
    const harness = transactionHarness("completed");

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "awaiting_approval",
        expectedStatus: "completed",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("completed");
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });

  it("does not let an owner change an externally executing task behind its active claim", async () => {
    const harness = transactionHarness("in_progress");

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "cancelled",
        expectedStatus: "in_progress",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("in_progress");
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });

  it.each([
    "pending",
    "in_progress",
    "completed",
    "failed",
    "cancelled",
  ] as const)(
    "requires the evidence-bound reconciliation route before changing an unknown external outcome to %s",
    async nextStatus => {
      const harness = transactionHarness("awaiting_approval", {
        external_outcome_reconciliation_required: true,
        external_outcome_reconciliation_id:
          "22222222-2222-4222-8222-222222222222",
      });

      const result = await updateTaskByOwnerWithAudit(
        9,
        {
          status: nextStatus,
          expectedStatus: "awaiting_approval",
        },
        harness.database as never
      );

      expect(result).toEqual({
        outcome: "approval_stale",
        previousStatus: "awaiting_approval",
        nextStatus,
      });
      expect(harness.task.status).toBe("awaiting_approval");
      expect(harness.updateCount).toBe(0);
      expect(harness.audit).toHaveLength(0);
    }
  );

  it("rolls the task change back when the audit insert fails", async () => {
    const harness = transactionHarness("pending");
    harness.failNextAuditInsert();

    await expect(
      updateTaskByOwnerWithAudit(
        9,
        { status: "failed", expectedStatus: "pending" },
        harness.database as never
      )
    ).rejects.toThrow("simulated audit insert failure");

    expect(harness.task.status).toBe("pending");
    expect(harness.task.completedAt).toBeNull();
    expect(harness.audit).toHaveLength(0);
  });

  it("updates priority without creating a status event", async () => {
    const harness = transactionHarness("pending");

    const result = await updateTaskByOwnerWithAudit(
      9,
      { priorityScore: 70 },
      harness.database as never
    );

    expect(result.statusChanged).toBe(false);
    expect(harness.task.priorityScore).toBe(70);
    expect(harness.audit).toHaveLength(0);
  });

  it("binds an awaiting-to-pending owner approval to the exact task", async () => {
    const harness = transactionHarness("awaiting_approval");

    await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint:
          externalTaskApprovalFingerprint(harness.task),
        approvalRequestId,
        approvalSource: "verified_sms",
      },
      harness.database as never
    );

    expect(harness.audit).toEqual([
      expect.objectContaining({
        taskId: 9,
        actionType: "owner_task_status_update",
        details: expect.objectContaining({
          previousStatus: "awaiting_approval",
          nextStatus: "pending",
          actor: "verified_owner",
          approvalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          approvalRequestId,
        }),
        outcome: "success",
      }),
    ]);
  });

  it("records the current request ID for an internal dashboard approval", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.task.actionType = "web_research";
    harness.setApprovalBoundary([
      {
        actionType: "confidence_gate_escalation",
        details: {
          approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
          approvalRequestId,
          presentationMode: "status_only",
          notificationSent: false,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalRequestId,
      },
      harness.database as never
    );

    expect(result.outcome).toBe("updated");
    expect(harness.audit).toEqual([
      expect.objectContaining({
        actionType: "owner_task_status_update",
        details: expect.objectContaining({
          approvalRequestId,
          approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
        }),
      }),
    ]);
  });

  it("keeps a changed task awaiting approval when its shown fingerprint is stale", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: { approvalFingerprint: "0".repeat(64) },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint:
          externalTaskApprovalFingerprint(harness.task),
      },
      harness.database as never
    );

    expect(result).toEqual({
      outcome: "approval_stale",
      previousStatus: "awaiting_approval",
      nextStatus: "pending",
    });
    expect(harness.task.status).toBe("awaiting_approval");
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });

  it.each([
    {
      label: "the complete artifact was not presented",
      details: {
        presentationMode: "dashboard_required",
        notificationSent: true,
      },
    },
    {
      label: "the approval notification was suppressed",
      details: {
        presentationMode: "sms_full",
        notificationSent: false,
      },
    },
  ])("keeps an external task awaiting approval when $label", async ({ details }) => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          approvalRequestId,
          ...details,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint:
          externalTaskApprovalFingerprint(harness.task),
        approvalRequestId,
        approvalSource: "verified_sms",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("awaiting_approval");
    expect(harness.audit).toHaveLength(0);
  });

  it("accepts an exact artifact reviewed in the authenticated dashboard", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          approvalRequestId,
          presentationMode: "dashboard_full",
          notificationSent: false,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint:
          externalTaskApprovalFingerprint(harness.task),
        approvalRequestId,
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("updated");
    expect(harness.task.status).toBe("pending");
    expect(harness.audit).toEqual([
      expect.objectContaining({
        actionType: "owner_task_status_update",
        details: expect.objectContaining({
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          approvalRequestId,
        }),
      }),
    ]);
  });

  it("accepts a short exact artifact reviewed in the authenticated dashboard when its SMS notification was suppressed", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          approvalRequestId,
          presentationMode: "sms_full",
          notificationSent: false,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint:
          externalTaskApprovalFingerprint(harness.task),
        approvalRequestId,
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("updated");
    expect(harness.task.status).toBe("pending");
  });

  it("rejects a dashboard approval that does not match the displayed fingerprint", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          presentationMode: "dashboard_full",
          notificationSent: false,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint: "0".repeat(64),
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("awaiting_approval");
  });

  it("rejects a stale dashboard fingerprint even when the newest boundary was fully sent by SMS", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          presentationMode: "sms_full",
          notificationSent: true,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint: "f".repeat(64),
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("awaiting_approval");
  });

  it("keeps an unknown external provider outcome held for explicit reconciliation", async () => {
    const harness = transactionHarness("awaiting_approval");
    harness.setApprovalBoundary([
      {
        actionType:
          "task_execution_external_outcome_reconciliation_required",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          presentationMode: "sms_full",
          notificationSent: true,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      { status: "pending", expectedStatus: "awaiting_approval" },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("awaiting_approval");
  });

  it("rejects a status transition when the locked row no longer matches the caller's state", async () => {
    const harness = transactionHarness("in_progress");

    const result = await updateTaskByOwnerWithAudit(
      9,
      { status: "pending", expectedStatus: "awaiting_approval" },
      harness.database as never
    );

    expect(result).toEqual({
      outcome: "state_conflict",
      previousStatus: "in_progress",
      expectedStatus: "awaiting_approval",
      nextStatus: "pending",
    });
    expect(harness.task.status).toBe("in_progress");
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });

  it("keeps a durable unknown-outcome hold even if its audit boundary is unavailable", async () => {
    const harness = transactionHarness("awaiting_approval", {
      external_outcome_reconciliation_required: true,
    });
    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint:
            externalTaskApprovalFingerprint(harness.task),
          presentationMode: "sms_full",
          notificationSent: true,
        },
      },
    ]);

    const result = await updateTaskByOwnerWithAudit(
      9,
      { status: "pending", expectedStatus: "awaiting_approval" },
      harness.database as never
    );

    expect(result.outcome).toBe("approval_stale");
    expect(harness.task.status).toBe("awaiting_approval");
    expect(harness.updateCount).toBe(0);
  });
});

describe("atomic external-outcome reconciliation", () => {
  const reconciliationAt = "2026-07-30T04:00:00.000Z";
  const reconciliationId = "22222222-2222-4222-8222-222222222222";

  it("records confirmed completion without allowing a replay", async () => {
    const harness = transactionHarness("awaiting_approval", {
      external_outcome_reconciliation_required: true,
      external_outcome_reconciliation_at: reconciliationAt,
      external_outcome_reconciliation_id: reconciliationId,
      external_provider_receipt: {
        provider: "twilio",
        receiptId: "SM00000000000000000000000000000000",
      },
    });

    const result = await reconcileExternalOutcomeByOwner(
      9,
      {
        resolution: "confirmed_completed",
        evidence: "Twilio console shows delivered at 12:03 AWST.",
        expectedReconciliationId: reconciliationId,
      },
      harness.database as never
    );

    expect(result).toMatchObject({
      outcome: "reconciled",
      nextStatus: "completed",
      freshApprovalRequired: false,
    });
    expect(harness.task.status).toBe("completed");
    expect(harness.task.completedAt).toBeInstanceOf(Date);
    expect(harness.task.metadata).not.toHaveProperty(
      "external_outcome_reconciliation_required"
    );
    expect(harness.audit).toEqual([
      expect.objectContaining({
        actionType: "owner_external_outcome_reconciliation",
        outcome: "success",
        details: expect.objectContaining({
          resolution: "confirmed_completed",
          actor: "verified_owner",
        }),
      }),
    ]);
  });

  it("requires a fresh exact approval after confirmed non-delivery", async () => {
    const harness = transactionHarness("awaiting_approval", {
      external_outcome_reconciliation_required: true,
      external_outcome_reconciliation_at: reconciliationAt,
      external_outcome_reconciliation_id: reconciliationId,
    });

    const result = await reconcileExternalOutcomeByOwner(
      9,
      {
        resolution: "confirmed_not_performed",
        evidence: "Provider lookup confirms no message was created.",
        expectedReconciliationId: reconciliationId,
      },
      harness.database as never
    );

    expect(result).toMatchObject({
      outcome: "reconciled",
      nextStatus: "awaiting_approval",
      freshApprovalRequired: true,
      approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
    });
    expect(harness.task.status).toBe("awaiting_approval");
    expect(harness.task.metadata).not.toHaveProperty(
      "external_outcome_reconciliation_required"
    );
    expect(harness.audit.map(entry => entry.actionType)).toEqual([
      "owner_external_outcome_reconciliation",
      "external_contact_approval_request",
    ]);
    expect(harness.audit[1]).toMatchObject({
      details: {
        approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
        presentationMode: "dashboard_full",
        freshApprovalAfterReconciliation: true,
      },
    });

    if (result.outcome !== "reconciled" || !result.approvalRequestId) {
      throw new Error("Expected a fresh approval request ID");
    }
    const newApprovalRequestId = result.approvalRequestId;
    const staleReplay = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
        approvalRequestId,
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );
    expect(staleReplay.outcome).toBe("approval_stale");

    harness.setApprovalBoundary([
      {
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
          approvalRequestId: newApprovalRequestId,
          presentationMode: "dashboard_full",
          notificationSent: false,
        },
      },
    ]);
    const freshApproval = await updateTaskByOwnerWithAudit(
      9,
      {
        status: "pending",
        expectedStatus: "awaiting_approval",
        approvalFingerprint: externalTaskApprovalFingerprint(harness.task),
        approvalRequestId: newApprovalRequestId,
        approvalSource: "owner_dashboard",
      },
      harness.database as never
    );
    expect(freshApproval.outcome).toBe("updated");
    expect(harness.task.status).toBe("pending");
  });

  it("rejects a stale reconciliation decision without mutation", async () => {
    const harness = transactionHarness("awaiting_approval", {
      external_outcome_reconciliation_required: true,
      external_outcome_reconciliation_at: reconciliationAt,
      external_outcome_reconciliation_id: reconciliationId,
    });

    const result = await reconcileExternalOutcomeByOwner(
      9,
      {
        resolution: "cancelled_unknown",
        evidence: "Provider evidence is inconclusive; keep replay blocked.",
        expectedReconciliationId:
          "33333333-3333-4333-8333-333333333333",
      },
      harness.database as never
    );

    expect(result).toEqual({ outcome: "state_conflict" });
    expect(harness.task.status).toBe("awaiting_approval");
    expect(harness.updateCount).toBe(0);
    expect(harness.audit).toHaveLength(0);
  });
});
