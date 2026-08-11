import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyRetellTaskCallback: vi.fn(),
  claimPrivateCandidateJobSlot: vi.fn(),
  getRetellProviderPendingTasks: vi.fn(),
  logExecutionOnce: vi.fn(),
}));
const retellMocks = vi.hoisted(() => ({ getRetellCall: vi.fn() }));
const dagMocks = vi.hoisted(() => ({ unlockDependents: vi.fn() }));
const approvalMocks = vi.hoisted(() => ({
  externalApprovalArtifact: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../integrations/retell", () => retellMocks);
vi.mock("../autonomous/dagEngine", () => dagMocks);
vi.mock("../safety/externalTaskApproval", () => approvalMocks);

import { reconcileRetellProviderPendingCalls } from "./retellReconciler";

const now = new Date("2026-07-30T02:00:00.000Z");
const callId = "call_12345678";
const dispatchId = "22222222-2222-4222-8222-222222222222";
const task = {
  id: 42,
  actionType: "outbound_call",
  status: "in_progress",
  updatedAt: new Date("2026-07-30T01:40:00.000Z"),
  metadata: {
    external_provider_receipt: {
      provider: "retell",
      receiptId: callId,
    },
    external_provider_terminal_pending: true,
    external_dispatch_id: dispatchId,
  },
};
const artifact = {
  target: "+61422222222",
  providerIdentity: {
    provider: "retell",
    agentId: "agent_12345678",
    agentVersion: 7,
    from: "+61411111111",
  },
};
const providerCall = {
  callId,
  agentId: "agent_12345678",
  agentVersion: 7,
  direction: "outbound",
  fromNumber: "+61411111111",
  toNumber: "+61422222222",
  callStatus: "ended",
  disconnectionReason: "user_hangup",
  externalDispatchId: dispatchId,
  callSuccessful: true,
  callSummary: "Approved outcome completed.",
  userSentiment: "positive",
};

describe("Retell Get Call terminal reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("RETELL_TERMINAL_RECONCILIATION_CERTIFIED", "true");
    dbMocks.claimPrivateCandidateJobSlot.mockResolvedValue(true);
    dbMocks.getRetellProviderPendingTasks.mockResolvedValue([task]);
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "completed",
    });
    dbMocks.logExecutionOnce.mockResolvedValue(true);
    approvalMocks.externalApprovalArtifact.mockReturnValue(artifact);
    retellMocks.getRetellCall.mockResolvedValue(providerCall);
  });

  it("is default-off and performs no provider read", async () => {
    vi.stubEnv("RETELL_TERMINAL_RECONCILIATION_CERTIFIED", "");

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 0, transitioned: 0 });
    expect(dbMocks.claimPrivateCandidateJobSlot).not.toHaveBeenCalled();
    expect(retellMocks.getRetellCall).not.toHaveBeenCalled();
  });

  it("never reads the provider inside the private candidate", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 0, transitioned: 0 });

    expect(dbMocks.claimPrivateCandidateJobSlot).not.toHaveBeenCalled();
    expect(retellMocks.getRetellCall).not.toHaveBeenCalled();
  });

  it("uses one distributed minute slot across live instances", async () => {
    dbMocks.claimPrivateCandidateJobSlot.mockResolvedValue(false);

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 0, transitioned: 0 });
    expect(dbMocks.claimPrivateCandidateJobSlot).toHaveBeenCalledWith(
      "retell-reconciler",
      "2026-07-30T02:00"
    );
    expect(retellMocks.getRetellCall).not.toHaveBeenCalled();
  });

  it("completes and unlocks only an exact successful terminal call", async () => {
    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 1, transitioned: 1 });

    expect(retellMocks.getRetellCall).toHaveBeenCalledWith(callId);
    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "completed",
      expect.objectContaining({
        eventType: "call_analyzed",
        callSuccessful: true,
        callStatus: "ended",
      })
    );
    expect(dagMocks.unlockDependents).toHaveBeenCalledWith(42);
  });

  it("fails an exact terminal call with negative analysis", async () => {
    retellMocks.getRetellCall.mockResolvedValue({
      ...providerCall,
      callSuccessful: false,
    });
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "failed",
    });

    await reconcileRetellProviderPendingCalls(now);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "failed",
      expect.objectContaining({ callSuccessful: false })
    );
    expect(dagMocks.unlockDependents).not.toHaveBeenCalled();
  });

  it("fails a provider-confirmed not-connected call without redial", async () => {
    retellMocks.getRetellCall.mockResolvedValue({
      ...providerCall,
      callStatus: "not_connected",
      callSuccessful: undefined,
      disconnectionReason: "dial_no_answer",
    });
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "failed",
    });

    await reconcileRetellProviderPendingCalls(now);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "failed",
      expect.objectContaining({
        eventType: "call_ended",
        callStatus: "not_connected",
      })
    );
    expect(dagMocks.unlockDependents).not.toHaveBeenCalled();
  });

  it("waits through the analysis grace period without guessing", async () => {
    dbMocks.getRetellProviderPendingTasks.mockResolvedValue([
      {
        ...task,
        updatedAt: new Date("2026-07-30T01:50:01.000Z"),
      },
    ]);
    retellMocks.getRetellCall.mockResolvedValue({
      ...providerCall,
      callSuccessful: undefined,
    });

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 1, transitioned: 0 });
    expect(dbMocks.applyRetellTaskCallback).not.toHaveBeenCalled();
  });

  it("routes missing analysis beyond grace to reconciliation", async () => {
    retellMocks.getRetellCall.mockResolvedValue({
      ...providerCall,
      callSuccessful: undefined,
    });
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "awaiting_approval",
    });

    await reconcileRetellProviderPendingCalls(now);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "reconciliation_required",
      expect.objectContaining({ callStatus: "ended" })
    );
    expect(dagMocks.unlockDependents).not.toHaveBeenCalled();
  });

  it("quarantines any provider identity or dispatch mismatch", async () => {
    retellMocks.getRetellCall.mockResolvedValue({
      ...providerCall,
      externalDispatchId: "substituted",
    });
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "awaiting_approval",
    });

    await reconcileRetellProviderPendingCalls(now);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "reconciliation_required",
      expect.objectContaining({
        disconnectionReason: "provider_identity_mismatch",
      })
    );
  });

  it("never unlocks when the callback CAS is stale", async () => {
    dbMocks.applyRetellTaskCallback.mockResolvedValue({ outcome: "stale" });

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 1, transitioned: 0 });
    expect(dagMocks.unlockDependents).not.toHaveBeenCalled();
    expect(dbMocks.logExecutionOnce).not.toHaveBeenCalled();
  });

  it("records a bounded read failure and never invents an outcome", async () => {
    retellMocks.getRetellCall.mockRejectedValue(
      new Error("Retell Get Call error (503)")
    );

    await expect(
      reconcileRetellProviderPendingCalls(now)
    ).resolves.toEqual({ inspected: 1, transitioned: 0 });
    expect(dbMocks.applyRetellTaskCallback).not.toHaveBeenCalled();
    expect(dbMocks.logExecutionOnce).toHaveBeenCalledWith(
      expect.stringContaining("get-call-error"),
      expect.objectContaining({
        actionType: "retell_get_call_error",
        details: expect.objectContaining({
          automaticRedialBlocked: true,
        }),
      })
    );
  });
});
