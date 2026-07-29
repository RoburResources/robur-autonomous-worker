import { describe, expect, it, vi } from "vitest";
import {
  updateTaskByOwnerWithAudit,
  type OwnerTaskUpdateResult,
} from "./db";

type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_approval";

function transactionHarness(initialStatus: TaskStatus) {
  let task = {
    id: 9,
    status: initialStatus,
    priorityScore: 50,
    completedAt: null as Date | null,
  };
  const audit: Array<Record<string, unknown>> = [];
  let failAuditInsert = false;
  let rowLockCount = 0;
  let updateCount = 0;

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
  };
}

describe("atomic owner task update", () => {
  it("locks the task and commits the status change with its audit event", async () => {
    const harness = transactionHarness("pending");

    const result = await updateTaskByOwnerWithAudit(
      9,
      { status: "failed" },
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

  it("rolls the task change back when the audit insert fails", async () => {
    const harness = transactionHarness("pending");
    harness.failNextAuditInsert();

    await expect(
      updateTaskByOwnerWithAudit(
        9,
        { status: "failed" },
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
});
