/**
 * Read-only recovery for a Retell terminal webhook that never arrived.
 *
 * The reconciler never places or retries a call. It reads Get Call, binds the
 * result to the exact approved artifact and dispatch receipt, then applies the
 * same terminal CAS used by authenticated webhooks.
 */

import {
  applyRetellTaskCallback,
  claimPrivateCandidateJobSlot,
  getRetellProviderPendingTasks,
  logExecutionOnce,
} from "../db";
import { unlockDependents } from "../autonomous/dagEngine";
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";
import { normalizeTaskMetadata } from "../autonomous/taskMetadata";
import { getRetellCall } from "../integrations/retell";
import { externalApprovalArtifact } from "../safety/externalTaskApproval";

const MIN_PENDING_AGE_MS = 60_000;
const ANALYSIS_GRACE_MS = 15 * 60_000;
const MAX_NONTERMINAL_AGE_MS = 2 * 60 * 60_000;
let reconciliationInFlight = false;

type ReconciliationResolution =
  | "completed"
  | "failed"
  | "reconciliation_required";

function certified(): boolean {
  return process.env.RETELL_TERMINAL_RECONCILIATION_CERTIFIED === "true";
}

function receiptIdFromMetadata(metadata: Record<string, unknown>): string {
  const receipt =
    metadata.external_provider_receipt &&
    typeof metadata.external_provider_receipt === "object" &&
    !Array.isArray(metadata.external_provider_receipt)
      ? (metadata.external_provider_receipt as Record<string, unknown>)
      : {};
  return receipt.provider === "retell" && typeof receipt.receiptId === "string"
    ? receipt.receiptId
    : "";
}

async function applyResolution(input: {
  taskId: number;
  callId: string;
  resolution: ReconciliationResolution;
  eventType: "call_ended" | "call_analyzed";
  callSuccessful?: boolean;
  callSummary?: string;
  userSentiment?: string;
  disconnectionReason?: string;
  callStatus?: string;
}): Promise<"updated" | "stale"> {
  const result = await applyRetellTaskCallback(
    input.taskId,
    input.callId,
    input.resolution,
    {
      eventType: input.eventType,
      ...(input.callSuccessful === undefined
        ? {}
        : { callSuccessful: input.callSuccessful }),
      ...(input.callSummary ? { callSummary: input.callSummary } : {}),
      ...(input.userSentiment
        ? { userSentiment: input.userSentiment }
        : {}),
      ...(input.disconnectionReason
        ? { disconnectionReason: input.disconnectionReason }
        : {}),
      ...(input.callStatus ? { callStatus: input.callStatus } : {}),
    }
  );
  if (result.outcome !== "updated") return "stale";
  if (result.status === "completed") {
    await unlockDependents(input.taskId);
  }
  await logExecutionOnce(
    `retell:${input.callId}:get-call:${input.resolution}`,
    {
      taskId: input.taskId,
      actionType: "retell_get_call_reconciliation",
      details: {
        callId: input.callId,
        resolution: input.resolution,
        callStatus: input.callStatus || "",
        authenticatedProviderRead: true,
        automaticRedialBlocked: true,
      },
      outcome:
        input.resolution === "completed"
          ? "success"
          : input.resolution === "failed"
            ? "failure"
            : "partial",
    }
  );
  return "updated";
}

export async function reconcileRetellProviderPendingCalls(
  now = new Date()
): Promise<{ inspected: number; transitioned: number }> {
  if (isPrivateCandidateInternalOnly() || !certified() || reconciliationInFlight) {
    return { inspected: 0, transitioned: 0 };
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Retell reconciliation time is invalid");
  }

  const slot = now.toISOString().slice(0, 16);
  if (!(await claimPrivateCandidateJobSlot("retell-reconciler", slot))) {
    return { inspected: 0, transitioned: 0 };
  }

  reconciliationInFlight = true;
  try {
    const tasks = await getRetellProviderPendingTasks(
      new Date(now.getTime() - MIN_PENDING_AGE_MS),
      25
    );
    let transitioned = 0;
    for (const task of tasks) {
      const metadata = normalizeTaskMetadata(task.metadata);
      const callId = receiptIdFromMetadata(metadata);
      if (!callId) continue;
      const ageMs = Math.max(0, now.getTime() - task.updatedAt.getTime());
      const approvedArtifact = externalApprovalArtifact(task);
      const approvedIdentity =
        approvedArtifact?.providerIdentity.provider === "retell"
          ? approvedArtifact.providerIdentity
          : null;
      const expectedDispatchId =
        typeof metadata.external_dispatch_id === "string"
          ? metadata.external_dispatch_id
          : "";

      if (!approvedArtifact || !approvedIdentity || !expectedDispatchId) {
        if (
          (await applyResolution({
            taskId: task.id,
            callId,
            resolution: "reconciliation_required",
            eventType: "call_analyzed",
            callStatus: "local_identity_missing",
          })) === "updated"
        ) {
          transitioned += 1;
        }
        continue;
      }

      try {
        const call = await getRetellCall(callId);
        const identityMatches =
          call.callId === callId &&
          call.agentId === approvedIdentity.agentId &&
          call.agentVersion === approvedIdentity.agentVersion &&
          call.direction === "outbound" &&
          call.fromNumber === approvedIdentity.from &&
          call.toNumber === approvedArtifact.target &&
          call.externalDispatchId === expectedDispatchId;
        if (!identityMatches) {
          if (
            (await applyResolution({
              taskId: task.id,
              callId,
              resolution: "reconciliation_required",
              eventType: "call_analyzed",
              callStatus: call.callStatus,
              disconnectionReason: "provider_identity_mismatch",
            })) === "updated"
          ) {
            transitioned += 1;
          }
          continue;
        }

        const status = call.callStatus.toLowerCase();
        let resolution: ReconciliationResolution | null = null;
        let eventType: "call_ended" | "call_analyzed" = "call_analyzed";
        if (status === "ended" && call.callSuccessful === true) {
          resolution = "completed";
        } else if (
          status === "ended" &&
          call.callSuccessful === false
        ) {
          resolution = "failed";
        } else if (status === "error" || status === "not_connected") {
          resolution = "failed";
          eventType = "call_ended";
        } else if (
          (status === "ended" && ageMs >= ANALYSIS_GRACE_MS) ||
          (!["registered", "ongoing", "ended"].includes(status) &&
            ageMs >= ANALYSIS_GRACE_MS) ||
          ageMs >= MAX_NONTERMINAL_AGE_MS
        ) {
          resolution = "reconciliation_required";
        }
        if (!resolution) continue;

        if (
          (await applyResolution({
            taskId: task.id,
            callId,
            resolution,
            eventType,
            ...(call.callSuccessful === undefined
              ? {}
              : { callSuccessful: call.callSuccessful }),
            ...(call.callSummary
              ? { callSummary: call.callSummary }
              : {}),
            ...(call.userSentiment
              ? { userSentiment: call.userSentiment }
              : {}),
            ...(call.disconnectionReason
              ? { disconnectionReason: call.disconnectionReason }
              : {}),
            callStatus: call.callStatus,
          })) === "updated"
        ) {
          transitioned += 1;
        }
      } catch (error) {
        const hour = now.toISOString().slice(0, 13);
        await logExecutionOnce(
          `retell:${callId}:get-call-error:${hour}`,
          {
            taskId: task.id,
            actionType: "retell_get_call_error",
            details: {
              callId,
              automaticRedialBlocked: true,
            },
            outcome: "partial",
            errorMessage: (
              error instanceof Error ? error.message : "Retell read failed"
            ).slice(0, 500),
          }
        ).catch(() => false);
      }
    }
    return { inspected: tasks.length, transitioned };
  } finally {
    reconciliationInFlight = false;
  }
}

export function startRetellTerminalReconciler(): () => void {
  const run = () => {
    void reconcileRetellProviderPendingCalls().catch(error => {
      console.error(
        "[Retell Reconciler] Failed:",
        error instanceof Error ? error.message : "unknown error"
      );
    });
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
