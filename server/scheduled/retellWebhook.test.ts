import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const dbMocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  logExecution: vi.fn(),
  getConfig: vi.fn(),
}));
const llmMocks = vi.hoisted(() => ({ invokeLLM: vi.fn() }));
const twilioMocks = vi.hoisted(() => ({ sendSMS: vi.fn() }));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../_core/llm", () => llmMocks);
vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);

import { retellWebhookHandler } from "./retellWebhook";

function responseMock(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("Retell webhook authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RETELL_API_KEY", "retell-test-key");
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
  });

  it("returns 403 before processing an unauthenticated event", async () => {
    const res = responseMock();
    const req = {
      headers: {},
      body: { event: "call_ended", call_id: "call-test" },
    } as unknown as Request;

    await retellWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(dbMocks.logExecution).not.toHaveBeenCalled();
    expect(dbMocks.createTask).not.toHaveBeenCalled();
  });

  it("acknowledges an authenticated non-call event without side effects", async () => {
    const res = responseMock();
    const req = {
      headers: { authorization: "retell-test-key" },
      body: { event: "ping" },
    } as unknown as Request;

    await retellWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(dbMocks.logExecution).not.toHaveBeenCalled();
  });

  it("acknowledges but does not process authenticated events while paused", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "Autonomous execution is paused by kill switch",
    });
    const res = responseMock();
    const req = {
      headers: { authorization: "retell-test-key" },
      body: {
        event: "call_ended",
        call: {
          call_id: "call-paused",
          agent_id: "agent_7f02eb1896dd1e6deb38e54942",
          transcript: "A long transcript that would otherwise create a task.",
        },
      },
    } as unknown as Request;

    await retellWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      received: true,
      ignored: "worker_paused",
    });
    expect(dbMocks.logExecution).not.toHaveBeenCalled();
    expect(dbMocks.createTask).not.toHaveBeenCalled();
    expect(llmMocks.invokeLLM).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });
});
