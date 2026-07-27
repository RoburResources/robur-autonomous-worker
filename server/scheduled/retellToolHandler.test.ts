import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const dbMocks = vi.hoisted(() => ({ createTask: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ getLegacyWorkerRuntimeGate: vi.fn() }));

vi.mock("../db", () => dbMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);

import { retellCreateTaskHandler } from "./retellToolHandler";

function requestMock(apiKey?: string): Request {
  return {
    body: {
      args: {
        description: "Private certification probe",
        action_type: "internal_research",
      },
    },
    headers: { authorization: apiKey },
  } as unknown as Request;
}

function responseMock(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("Retell create-task webhook containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RETELL_API_KEY", "retell-test-key");
  });

  it("rejects an unauthenticated request without writing", async () => {
    const res = responseMock();

    await retellCreateTaskHandler(requestMock(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(dbMocks.createTask).not.toHaveBeenCalled();
  });

  it("rejects an authenticated request while the worker is paused", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "Kill switch is active",
    });
    const res = responseMock();

    await retellCreateTaskHandler(requestMock("retell-test-key"), res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(dbMocks.createTask).not.toHaveBeenCalled();
  });

  it("allows a verified Retell request only when the runtime gate is open", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    dbMocks.createTask.mockResolvedValue([{ insertId: 42 }]);
    const res = responseMock();

    await retellCreateTaskHandler(requestMock("retell-test-key"), res);

    expect(dbMocks.createTask).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects oversized or malformed task input without writing", async () => {
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    const req = requestMock("retell-test-key");
    req.body.args.description = "x".repeat(2_001);
    req.body.args.action_type = "../../shell";
    const res = responseMock();

    await retellCreateTaskHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(dbMocks.createTask).not.toHaveBeenCalled();
  });
});
