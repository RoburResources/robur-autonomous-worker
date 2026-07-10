import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const sdkMocks = vi.hoisted(() => ({ authenticateRequest: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ getLegacyWorkerRuntimeGate: vi.fn() }));
const autonomousMocks = vi.hoisted(() => ({
  runTaskGenerator: vi.fn(),
  runTaskExecutor: vi.fn(),
  runEvaluator: vi.fn(),
  runSelfImprover: vi.fn(),
  runMorningBriefing: vi.fn(),
  runEveningBriefing: vi.fn(),
}));

vi.mock("../_core/sdk", () => ({ sdk: sdkMocks }));
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("../autonomous/taskGenerator", () => ({
  runTaskGenerator: autonomousMocks.runTaskGenerator,
}));
vi.mock("../autonomous/taskExecutor", () => ({
  runTaskExecutor: autonomousMocks.runTaskExecutor,
}));
vi.mock("../autonomous/evaluator", () => ({
  runEvaluator: autonomousMocks.runEvaluator,
}));
vi.mock("../autonomous/selfImprover", () => ({
  runSelfImprover: autonomousMocks.runSelfImprover,
}));
vi.mock("../autonomous/briefings", () => ({
  runMorningBriefing: autonomousMocks.runMorningBriefing,
  runEveningBriefing: autonomousMocks.runEveningBriefing,
}));

import { taskExecutorHandler } from "./handlers";

function responseMock(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("scheduled execution authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not invoke the executor for an unauthenticated request", async () => {
    sdkMocks.authenticateRequest.mockRejectedValue(new Error("invalid"));
    const res = responseMock();

    await taskExecutorHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(autonomousMocks.runTaskExecutor).not.toHaveBeenCalled();
  });

  it("does not invoke the executor for an authenticated non-cron user", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: false });

    await taskExecutorHandler({} as Request, responseMock());

    expect(autonomousMocks.runTaskExecutor).not.toHaveBeenCalled();
  });

  it("does not invoke the executor when the retirement gate is closed", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: true });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "retired",
    });
    const res = responseMock();

    await taskExecutorHandler({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(autonomousMocks.runTaskExecutor).not.toHaveBeenCalled();
  });

  it("invokes the executor only for cron plus an open runtime gate", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: true });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    autonomousMocks.runTaskExecutor.mockResolvedValue({ executed: false });

    await taskExecutorHandler({} as Request, responseMock());

    expect(autonomousMocks.runTaskExecutor).toHaveBeenCalledTimes(1);
  });
});
