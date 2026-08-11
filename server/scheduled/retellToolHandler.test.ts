import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const dbMocks = vi.hoisted(() => ({
  createTaskOnce: vi.fn(),
  getConfig: vi.fn(),
  getTaskByExternalProviderReceipt: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({ getLegacyWorkerRuntimeGate: vi.fn() }));
const retellMocks = vi.hoisted(() => ({ getRetellCall: vi.fn() }));

vi.mock("../db", () => dbMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("../integrations/retell", () => retellMocks);

import { computeRetellWebhookDigest } from "../integrations/retellWebhookAuth";
import { externalTaskApprovalSourceFingerprint } from "../safety/externalTaskApproval";
import { retellCreateTaskHandler } from "./retellToolHandler";

const apiKey = "retell-test-key";
const now = 1_785_370_000_000;
const ownerPhone = "+61400000000";
const agentId = "agent_7f02eb1896dd1e6deb38e54942";
const fromNumber = "+61411111111";
const dispatchId = "11111111-1111-4111-8111-111111111111";

function correlatedOwnerCallTask() {
  const base = {
    id: 7,
    source: "owner_briefing",
    description: "Call the owner with the approved briefing",
    actionType: "outbound_call",
    actionPayload: null,
    estimatedValue: null,
    metadata: {},
  };
  return {
    ...base,
    status: "in_progress",
    metadata: {
      external_dispatch_id: dispatchId,
      external_approval_artifact: {
        version: 1,
        sourceFingerprint: externalTaskApprovalSourceFingerprint(base),
        actionType: "outbound_call",
        target: ownerPhone,
        content: "Approved owner briefing script",
        providerIdentity: {
          provider: "retell",
          from: fromNumber,
          agentId,
          agentVersion: 1,
          agentConfigSha256: "a".repeat(64),
          scriptVariable: "approved_script",
        },
      },
    },
  };
}

function requestMock(options?: {
  agentId?: string;
  from?: string;
  signatureBody?: string;
  retryMarker?: string;
}): Request {
  const body = {
    name: "create_task",
    call: {
      call_id: "call_12345678",
      agent_id: options?.agentId ?? agentId,
      direction: "outbound",
      from_number: fromNumber,
      to_number: options?.from ?? ownerPhone,
      ...(options?.retryMarker ? { retry_marker: options.retryMarker } : {}),
    },
    args: {
      description: "Run a private certification research task",
      action_type: "web_research",
      priority: 90,
    },
  };
  const rawBody = JSON.stringify(body);
  const signedBody = options?.signatureBody ?? rawBody;
  const timestamp = String(now);
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
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("Retell create-task custom function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RETELL_WEBHOOK_API_KEY", apiKey);
    vi.stubEnv("RETELL_CUSTOM_TOOL_CHANNEL_CERTIFIED", "true");
    vi.stubEnv("RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION", "1");
    vi.spyOn(Date, "now").mockReturnValue(now);
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    dbMocks.getConfig.mockImplementation(async (key: string) =>
      key === "retell_executive_agent_id" ? agentId : ownerPhone
    );
    dbMocks.createTaskOnce.mockResolvedValue({ created: true, taskId: 42 });
    dbMocks.getTaskByExternalProviderReceipt.mockResolvedValue(
      correlatedOwnerCallTask()
    );
    retellMocks.getRetellCall.mockResolvedValue({
      callId: "call_12345678",
      agentId,
      agentVersion: 1,
      direction: "outbound",
      fromNumber,
      toNumber: ownerPhone,
      callStatus: "ongoing",
      disconnectionReason: "",
      externalDispatchId: dispatchId,
      callSummary: "",
      userSentiment: "",
    });
  });

  it("stays disabled until the custom-tool channel is separately certified", async () => {
    delete process.env.RETELL_CUSTOM_TOOL_CHANNEL_CERTIFIED;
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("rejects a request whose raw-body signature does not match", async () => {
    const res = responseMock();

    await retellCreateTaskHandler(
      requestMock({ signatureBody: "{}" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("rejects work while the runtime gate is paused", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "Kill switch is active",
    });
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("requires the exact executive agent and owner call identity", async () => {
    const wrongAgent = responseMock();
    await retellCreateTaskHandler(
      requestMock({ agentId: "agent_other1234" }),
      wrongAgent
    );
    expect(wrongAgent.status).toHaveBeenCalledWith(403);

    const wrongCaller = responseMock();
    await retellCreateTaskHandler(
      requestMock({ from: "+61499999999" }),
      wrongCaller
    );
    expect(wrongCaller.status).toHaveBeenCalledWith(403);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("requires the exact call identity read back from Retell", async () => {
    retellMocks.getRetellCall.mockResolvedValue({
      callId: "call_12345678",
      agentId,
      agentVersion: 1,
      direction: "outbound",
      fromNumber: "+61499999999",
      toNumber: ownerPhone,
      callStatus: "ongoing",
      disconnectionReason: "",
      callSummary: "",
      userSentiment: "",
    });
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it.each([
    ["ended call", { callStatus: "ended" }],
    ["unpinned agent version", { agentVersion: 2 }],
    ["missing dispatch binding", { externalDispatchId: undefined }],
  ])("rejects a %s", async (_label, change) => {
    retellMocks.getRetellCall.mockResolvedValue({
      callId: "call_12345678",
      agentId,
      agentVersion: 1,
      direction: "outbound",
      fromNumber,
      toNumber: ownerPhone,
      callStatus: "ongoing",
      disconnectionReason: "",
      externalDispatchId: dispatchId,
      callSummary: "",
      userSentiment: "",
      ...change,
    });
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("requires a server-owned approved outbound call receipt", async () => {
    dbMocks.getTaskByExternalProviderReceipt.mockResolvedValue(null);
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("fails closed when provider read-back fails", async () => {
    retellMocks.getRetellCall.mockRejectedValue(new Error("provider unavailable"));
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(dbMocks.createTaskOnce).not.toHaveBeenCalled();
  });

  it("creates one idempotent task for an authenticated owner call", async () => {
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(dbMocks.createTaskOnce).toHaveBeenCalledWith(
      expect.stringMatching(/^retell-tool:[a-f0-9]{64}$/),
      expect.objectContaining({
        source: "retell_tool_call",
        actionType: "web_research",
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("reports an exact replay without creating another task", async () => {
    dbMocks.createTaskOnce.mockResolvedValue({ created: false });
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.json).toHaveBeenCalledWith({
      result: "That exact task was already logged.",
    });
  });

  it("uses one semantic idempotency key across harmless provider reserialization", async () => {
    const first = responseMock();
    const second = responseMock();

    await retellCreateTaskHandler(requestMock(), first);
    await retellCreateTaskHandler(
      requestMock({ retryMarker: "provider-retry-2" }),
      second
    );

    expect(dbMocks.createTaskOnce).toHaveBeenCalledTimes(2);
    expect(dbMocks.createTaskOnce.mock.calls[0][0]).toBe(
      dbMocks.createTaskOnce.mock.calls[1][0]
    );
  });
});
