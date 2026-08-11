import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const dbMocks = vi.hoisted(() => ({
  applyRetellTaskCallback: vi.fn(),
  createTaskOnce: vi.fn(),
  getConfig: vi.fn(),
  getTaskByExternalProviderReceipt: vi.fn(),
  logExecutionOnce: vi.fn(),
}));
const dagMocks = vi.hoisted(() => ({ unlockDependents: vi.fn() }));
const approvalMocks = vi.hoisted(() => ({
  externalApprovalArtifact: vi.fn(),
}));
const abMocks = vi.hoisted(() => ({ recordVariantOutcome: vi.fn() }));
const memoryMocks = vi.hoisted(() => ({ storeContactInteraction: vi.fn() }));
const llmMocks = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
}));
const inboxMocks = vi.hoisted(() => ({
  claimRetellWebhook: vi.fn(),
  completeRetellWebhook: vi.fn(),
  enqueueRetellWebhook: vi.fn(),
  listRetellWebhookInboxKeys: vi.fn(),
  releaseRetellWebhookForRetry: vi.fn(),
  stageRetellWebhookWorkProduct: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../_core/llm", () => llmMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("./retellWebhookInbox", () => inboxMocks);
vi.mock("../autonomous/dagEngine", () => dagMocks);
vi.mock("../safety/externalTaskApproval", () => approvalMocks);
vi.mock("../autonomous/abTesting", () => abMocks);
vi.mock("../memory/mem0", () => memoryMocks);

import { computeRetellWebhookDigest } from "../integrations/retellWebhookAuth";
import {
  drainRetellWebhookInbox,
  processRetellWebhookClaim,
  retellWebhookHandler,
} from "./retellWebhook";

const apiKey = "retell-test-key";
const now = 1_785_370_000_000;
const callId = "call_12345678";
const agentId = "agent_7f02eb1896dd1e6deb38e54942";
const ownerPhone = "+61400000000";

function signedRequest(
  body: Record<string, unknown>,
  options?: { signatureBody?: string; timestamp?: number }
): Request {
  const rawBody = JSON.stringify(body);
  const signedBody = options?.signatureBody ?? rawBody;
  const timestamp = String(options?.timestamp ?? now);
  const signature = `v=${timestamp},d=${computeRetellWebhookDigest(
    signedBody,
    apiKey,
    timestamp
  )}`;
  return {
    body,
    rawBody,
    get: (name: string) =>
      name.toLowerCase() === "x-retell-signature" ? signature : undefined,
  } as unknown as Request;
}

function responseMock(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    send: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response;
}

function eventBody(overrides?: Record<string, unknown>) {
  return {
    event: "call_ended",
    call: {
      call_id: callId,
      agent_id: agentId,
      direction: "inbound",
      from_number: ownerPhone,
      to_number: "+61411111111",
      start_timestamp: 1_785_369_990_000,
      end_timestamp: 1_785_370_000_000,
      transcript:
        "Michael: Please research the current steel market and give me a concise evidence-based summary. Addison: Understood.",
    },
    ...overrides,
  };
}

describe("Retell event webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RETELL_WEBHOOK_API_KEY", apiKey);
    vi.stubEnv("RETELL_EVENT_WEBHOOK_CERTIFIED", "true");
    vi.spyOn(Date, "now").mockReturnValue(now);
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "paused",
    });
    inboxMocks.enqueueRetellWebhook.mockResolvedValue({
      disposition: "accepted",
      key: "a".repeat(64),
      created: true,
    });
    inboxMocks.claimRetellWebhook.mockResolvedValue({
      disposition: "completed",
    });
    inboxMocks.completeRetellWebhook.mockResolvedValue(true);
    inboxMocks.stageRetellWebhookWorkProduct.mockResolvedValue(true);
    inboxMocks.releaseRetellWebhookForRetry.mockResolvedValue({
      released: true,
      terminal: false,
    });
    dbMocks.getConfig.mockImplementation(async (key: string) =>
      key === "retell_executive_agent_id" ? agentId : ownerPhone
    );
    dbMocks.getTaskByExternalProviderReceipt.mockResolvedValue(null);
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "completed",
    });
    dbMocks.createTaskOnce.mockResolvedValue({ created: true, taskId: 42 });
    dbMocks.logExecutionOnce.mockResolvedValue(true);
    dagMocks.unlockDependents.mockResolvedValue([]);
    approvalMocks.externalApprovalArtifact.mockReturnValue(null);
    abMocks.recordVariantOutcome.mockResolvedValue(undefined);
    memoryMocks.storeContactInteraction.mockResolvedValue(undefined);
  });

  it("keeps provider ingress disabled until separately certified", async () => {
    delete process.env.RETELL_EVENT_WEBHOOK_CERTIFIED;
    const res = responseMock();

    await retellWebhookHandler(signedRequest(eventBody()), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(inboxMocks.enqueueRetellWebhook).not.toHaveBeenCalled();
  });

  it("never drains queued provider events inside the private candidate", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");

    await expect(drainRetellWebhookInbox()).resolves.toBe(0);

    expect(inboxMocks.listRetellWebhookInboxKeys).not.toHaveBeenCalled();
    expect(inboxMocks.claimRetellWebhook).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before any durable write", async () => {
    const res = responseMock();
    const req = signedRequest(eventBody(), { signatureBody: "{}" });

    await retellWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(inboxMocks.enqueueRetellWebhook).not.toHaveBeenCalled();
  });

  it("durably enqueues before acknowledging a valid event", async () => {
    const res = responseMock();

    await retellWebhookHandler(signedRequest(eventBody()), res);

    expect(inboxMocks.enqueueRetellWebhook).toHaveBeenCalledWith(
      "call_ended",
      callId,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.objectContaining({
        event: "call_ended",
        call: expect.objectContaining({ call_id: callId }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it("returns a retryable failure when the durable inbox is unavailable", async () => {
    inboxMocks.enqueueRetellWebhook.mockRejectedValue(
      new Error("database unavailable")
    );
    const res = responseMock();

    await retellWebhookHandler(signedRequest(eventBody()), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("fails closed when one event identity is replayed with different data", async () => {
    inboxMocks.enqueueRetellWebhook.mockResolvedValue({
      disposition: "conflict",
    });
    const res = responseMock();

    await retellWebhookHandler(signedRequest(eventBody()), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("stages one deterministic owner plan before idempotent task creation", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    llmMocks.invokeLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tasks: [
                {
                  description:
                    "Research the current steel market and provide an evidence-based summary",
                  actionType: "web_research",
                  priorityScore: 90,
                },
              ],
              summary: "Michael requested steel-market research.",
            }),
          },
        },
      ],
    });
    const claim = {
      disposition: "acquired" as const,
      key: "b".repeat(64),
      token: "11111111-1111-4111-8111-111111111111",
      eventType: "call_ended",
      callId,
      payload: eventBody(),
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(
      inboxMocks.stageRetellWebhookWorkProduct.mock.invocationCallOrder[0]
    ).toBeLessThan(dbMocks.createTaskOnce.mock.invocationCallOrder[0]);
    expect(dbMocks.createTaskOnce).toHaveBeenCalledWith(
      `retell:${callId}:call_ended:0`,
      expect.objectContaining({
        source: "call_instruction",
        actionType: "web_research",
      })
    );
    expect(dbMocks.logExecutionOnce).toHaveBeenCalledWith(
      `retell:${callId}:call_ended:audit`,
      expect.objectContaining({ actionType: "retell_call_ended" })
    );
    expect(inboxMocks.completeRetellWebhook).toHaveBeenCalledWith(
      claim.key,
      claim.token
    );
  });

  it("reuses a staged plan after a crash instead of invoking the model again", async () => {
    const claim = {
      disposition: "acquired" as const,
      key: "c".repeat(64),
      token: "22222222-2222-4222-8222-222222222222",
      eventType: "call_ended",
      callId,
      payload: eventBody(),
      workProduct: {
        disposition: "owner_instruction",
        eventType: "call_ended",
        callId,
        agentId,
        direction: "inbound",
        fromNumber: ownerPhone,
        toNumber: "+61411111111",
        durationMs: 10_000,
        disconnectionReason: "user_hangup",
        callStatus: "ended",
        callSummary: "",
        userSentiment: "",
        tasks: [
          {
            description:
              "Research the current steel market and provide an evidence-based summary",
            actionType: "web_research",
            priorityScore: 90,
          },
        ],
        summary: "Michael requested steel-market research.",
      },
      attemptCount: 2,
    };

    await processRetellWebhookClaim(claim);

    expect(llmMocks.invokeLLM).not.toHaveBeenCalled();
    expect(inboxMocks.stageRetellWebhookWorkProduct).toHaveBeenCalledWith(
      claim.key,
      claim.token,
      claim.workProduct
    );
    expect(dbMocks.createTaskOnce).toHaveBeenCalledTimes(1);
  });

  it("does not apply a recovered work product after losing its final lease fence", async () => {
    inboxMocks.stageRetellWebhookWorkProduct.mockResolvedValue(false);
    const claim = {
      disposition: "acquired" as const,
      key: "1".repeat(64),
      token: "99999999-9999-4999-8999-999999999999",
      eventType: "call_ended",
      callId,
      payload: eventBody(),
      workProduct: {
        disposition: "owner_instruction",
        eventType: "call_ended",
        callId,
        agentId,
        direction: "inbound",
        fromNumber: ownerPhone,
        toNumber: "+61411111111",
        durationMs: 10_000,
        disconnectionReason: "user_hangup",
        callStatus: "ended",
        callSummary: "",
        userSentiment: "",
        tasks: [
          {
            description:
              "Research the current steel market and provide an evidence-based summary",
            actionType: "web_research",
            priorityScore: 90,
          },
        ],
        summary: "Michael requested steel-market research.",
      },
      attemptCount: 2,
    };

    await processRetellWebhookClaim(claim);

    expect(inboxMocks.stageRetellWebhookWorkProduct).toHaveBeenCalledWith(
      claim.key,
      claim.token,
      claim.workProduct
    );
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
    expect(dbMocks.logExecutionOnce).not.toHaveBeenCalled();
    expect(dbMocks.applyRetellTaskCallback).not.toHaveBeenCalled();
    expect(inboxMocks.completeRetellWebhook).not.toHaveBeenCalled();
    expect(inboxMocks.releaseRetellWebhookForRetry).toHaveBeenCalledWith(
      claim.key,
      claim.token,
      "Retell work product lost its durable processing fence"
    );
  });

  it("records but never extracts instructions for another agent", async () => {
    const claim = {
      disposition: "acquired" as const,
      key: "d".repeat(64),
      token: "33333333-3333-4333-8333-333333333333",
      eventType: "call_ended",
      callId,
      payload: {
        ...eventBody(),
        call: { ...(eventBody().call as object), agent_id: "agent_other1234" },
      },
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(llmMocks.invokeLLM).not.toHaveBeenCalled();
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
    expect(dbMocks.logExecutionOnce).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: "partial" })
    );
  });

  it("never treats an outbound owner call as an inbound instruction", async () => {
    const claim = {
      disposition: "acquired" as const,
      key: "e".repeat(64),
      token: "44444444-4444-4444-8444-444444444444",
      eventType: "call_ended",
      callId,
      payload: {
        ...eventBody(),
        call: {
          ...(eventBody().call as object),
          direction: "outbound",
          from_number: "+61411111111",
          to_number: ownerPhone,
        },
      },
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(llmMocks.invokeLLM).not.toHaveBeenCalled();
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("releases a failed processing claim for bounded internal retry", async () => {
    dbMocks.getConfig.mockRejectedValue(new Error("temporary database failure"));
    const claim = {
      disposition: "acquired" as const,
      key: "f".repeat(64),
      token: "55555555-5555-4555-8555-555555555555",
      eventType: "call_ended",
      callId,
      payload: eventBody(),
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(inboxMocks.releaseRetellWebhookForRetry).toHaveBeenCalledWith(
      claim.key,
      claim.token,
      "temporary database failure"
    );
    expect(inboxMocks.completeRetellWebhook).not.toHaveBeenCalled();
  });

  it("applies analyzed success to the exact correlated provider-pending task while paused", async () => {
    const dispatchId = "22222222-2222-4222-8222-222222222222";
    const from = "+61411111111";
    dbMocks.getTaskByExternalProviderReceipt.mockResolvedValue({
      id: 42,
      status: "in_progress",
      source: "owner",
      description: "Make the approved owner call",
      actionType: "outbound_call",
      actionPayload: null,
      estimatedValue: null,
      metadata: {
        external_dispatch_id: dispatchId,
        external_provider_terminal_pending: true,
      },
    });
    approvalMocks.externalApprovalArtifact.mockReturnValue({
      version: 1,
      sourceFingerprint: "a".repeat(64),
      actionType: "outbound_call",
      target: ownerPhone,
      targetName: "Michael",
      content: "Use the approved script",
      experimentId: "experiment_1",
      variantId: "variant_1",
      providerIdentity: {
        provider: "retell",
        from,
        agentId,
        agentVersion: 7,
        agentConfigSha256: "b".repeat(64),
        scriptVariable: "approved_script",
      },
    });
    const claim = {
      disposition: "acquired" as const,
      key: "9".repeat(64),
      token: "66666666-6666-4666-8666-666666666666",
      eventType: "call_analyzed",
      callId,
      payload: {
        event: "call_analyzed",
        call: {
          call_id: callId,
          agent_id: agentId,
          agent_version: 7,
          direction: "outbound",
          from_number: from,
          to_number: ownerPhone,
          metadata: { external_dispatch_id: dispatchId },
          call_status: "ended",
          call_analysis: {
            call_successful: true,
            call_summary: "The approved objective was achieved.",
            user_sentiment: "Positive",
          },
        },
      },
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "completed",
      expect.objectContaining({
        eventType: "call_analyzed",
        callSuccessful: true,
      })
    );
    expect(dagMocks.unlockDependents).toHaveBeenCalledWith(42);
    expect(abMocks.recordVariantOutcome).toHaveBeenCalledWith({
      experimentId: "experiment_1",
      variantId: "variant_1",
      taskId: 42,
      success: true,
      confidenceScore: 1,
    });
    expect(memoryMocks.storeContactInteraction).not.toHaveBeenCalled();
    expect(llmMocks.invokeLLM).not.toHaveBeenCalled();
    expect(inboxMocks.completeRetellWebhook).toHaveBeenCalled();
  });

  it("routes missing analyzed truth to reconciliation without unlocking", async () => {
    const dispatchId = "22222222-2222-4222-8222-222222222222";
    const from = "+61411111111";
    dbMocks.getTaskByExternalProviderReceipt.mockResolvedValue({
      id: 42,
      status: "in_progress",
      source: "owner",
      description: "Make the approved owner call",
      actionType: "outbound_call",
      actionPayload: null,
      estimatedValue: null,
      metadata: {
        external_dispatch_id: dispatchId,
        external_provider_terminal_pending: true,
      },
    });
    approvalMocks.externalApprovalArtifact.mockReturnValue({
      actionType: "outbound_call",
      target: ownerPhone,
      providerIdentity: {
        provider: "retell",
        from,
        agentId,
        agentVersion: 7,
      },
    });
    dbMocks.applyRetellTaskCallback.mockResolvedValue({
      outcome: "updated",
      status: "awaiting_approval",
    });
    const claim = {
      disposition: "acquired" as const,
      key: "8".repeat(64),
      token: "77777777-7777-4777-8777-777777777777",
      eventType: "call_analyzed",
      callId,
      payload: {
        event: "call_analyzed",
        call: {
          call_id: callId,
          agent_id: agentId,
          agent_version: 7,
          direction: "outbound",
          from_number: from,
          to_number: ownerPhone,
          metadata: { external_dispatch_id: dispatchId },
          call_analysis: { call_summary: "No success field was configured." },
        },
      },
      attemptCount: 1,
    };

    await processRetellWebhookClaim(claim);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledWith(
      42,
      callId,
      "reconciliation_required",
      expect.objectContaining({ eventType: "call_analyzed" })
    );
    expect(dagMocks.unlockDependents).not.toHaveBeenCalled();
    expect(abMocks.recordVariantOutcome).not.toHaveBeenCalled();
    expect(memoryMocks.storeContactInteraction).not.toHaveBeenCalled();
  });

  it("completes an idempotent replay after the task callback committed before downstream work", async () => {
    const claim = {
      disposition: "acquired" as const,
      key: "7".repeat(64),
      token: "88888888-8888-4888-8888-888888888888",
      eventType: "call_analyzed",
      callId,
      payload: { event: "call_analyzed", call: { call_id: callId } },
      workProduct: {
        disposition: "recorded",
        eventType: "call_analyzed",
        callId,
        agentId,
        direction: "outbound",
        fromNumber: "+61411111111",
        toNumber: ownerPhone,
        durationMs: 10_000,
        disconnectionReason: "user_hangup",
        callStatus: "ended",
        callSuccessful: true,
        callSummary: "The approved objective was achieved.",
        userSentiment: "Positive",
        correlatedTaskId: 42,
        correlatedTaskStatus: "in_progress",
        callbackResolution: "completed",
        tasks: [],
        summary: "Verified call_analyzed event recorded",
      },
      attemptCount: 2,
    };
    dbMocks.applyRetellTaskCallback
      .mockResolvedValueOnce({ outcome: "updated", status: "completed" })
      .mockResolvedValueOnce({ outcome: "stale" });
    dagMocks.unlockDependents.mockResolvedValue([]);
    const completedTask = {
      id: 42,
      status: "completed",
      source: "owner",
      description: "Make the approved supplier call",
      actionType: "outbound_call",
      actionPayload: null,
      estimatedValue: null,
      metadata: {
        external_provider_terminal_pending: false,
        retell_terminal_callback: {
          eventType: "call_analyzed",
          callSuccessful: true,
        },
      },
    };
    dbMocks.getTaskByExternalProviderReceipt
      .mockRejectedValueOnce(new Error("simulated post-CAS crash boundary"))
      .mockResolvedValue(completedTask);
    approvalMocks.externalApprovalArtifact.mockReturnValue({
      version: 1,
      sourceFingerprint: "a".repeat(64),
      actionType: "outbound_call",
      target: "+61422222222",
      targetName: "Supplier One",
      content: "Use the approved supplier script",
      experimentId: "experiment_2",
      variantId: "variant_2",
      providerIdentity: {
        provider: "retell",
        from: "+61411111111",
        agentId,
        agentVersion: 7,
        agentConfigSha256: "b".repeat(64),
        scriptVariable: "approved_script",
      },
    });

    await processRetellWebhookClaim(claim);
    expect(inboxMocks.releaseRetellWebhookForRetry).toHaveBeenCalledWith(
      claim.key,
      claim.token,
      "simulated post-CAS crash boundary"
    );
    expect(inboxMocks.completeRetellWebhook).not.toHaveBeenCalled();

    await processRetellWebhookClaim(claim);

    expect(dbMocks.applyRetellTaskCallback).toHaveBeenCalledTimes(2);
    expect(dagMocks.unlockDependents).toHaveBeenCalledTimes(1);
    expect(abMocks.recordVariantOutcome).toHaveBeenCalledTimes(1);
    expect(memoryMocks.storeContactInteraction).toHaveBeenCalledTimes(1);
    expect(memoryMocks.storeContactInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        contactName: "Supplier One",
        idempotencyKey: `retell:${callId}:task:42:contact`,
      })
    );
    expect(inboxMocks.completeRetellWebhook).toHaveBeenCalledWith(
      claim.key,
      claim.token
    );
  });
});
