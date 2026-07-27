import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  runEvaluator: vi.fn(),
  runSelfImprover: vi.fn(),
  runTaskExecutor: vi.fn(),
  runTaskGenerator: vi.fn(),
  getLegacyWorkerRuntimeGate: vi.fn(),
  claimPrivateCandidateJobSlot: vi.fn(),
  logExecution: vi.fn(),
}));

vi.mock("./evaluator", () => ({
  runEvaluator: schedulerMocks.runEvaluator,
}));
vi.mock("./selfImprover", () => ({
  runSelfImprover: schedulerMocks.runSelfImprover,
}));
vi.mock("./taskExecutor", () => ({
  runTaskExecutor: schedulerMocks.runTaskExecutor,
}));
vi.mock("./taskGenerator", () => ({
  runTaskGenerator: schedulerMocks.runTaskGenerator,
}));
vi.mock("../safety/legacyWorkerGate", () => ({
  getLegacyWorkerRuntimeGate: schedulerMocks.getLegacyWorkerRuntimeGate,
}));
vi.mock("../db", () => ({
  claimPrivateCandidateJobSlot: schedulerMocks.claimPrivateCandidateJobSlot,
  logExecution: schedulerMocks.logExecution,
}));

import {
  getPrivateCandidateDueJobs,
  runPrivateCandidateSchedulerTick,
} from "./privateCandidateScheduler";

describe("private candidate scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_AUTONOMY", "true");
    schedulerMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: true,
    });
    schedulerMocks.claimPrivateCandidateJobSlot.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs the executor every 15 minutes", () => {
    expect(
      getPrivateCandidateDueJobs(new Date("2026-07-27T12:15:00.000Z"))
    ).toEqual(["task-executor"]);
  });

  it("runs hourly generation before execution", () => {
    expect(
      getPrivateCandidateDueJobs(new Date("2026-07-27T12:00:00.000Z"))
    ).toEqual(["task-generator", "task-executor"]);
  });

  it("adds daily evaluation and weekly improvement at their UTC slots", () => {
    expect(
      getPrivateCandidateDueJobs(new Date("2026-07-27T10:00:00.000Z"))
    ).toEqual(["task-generator", "task-executor", "evaluator"]);
    expect(
      getPrivateCandidateDueJobs(new Date("2026-08-02T14:00:00.000Z"))
    ).toEqual(["task-generator", "task-executor", "self-improver"]);
  });

  it("runs only after atomically claiming the distributed slot", async () => {
    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-27T12:30:00.000Z")
    );

    expect(schedulerMocks.claimPrivateCandidateJobSlot).toHaveBeenCalledWith(
      "task-executor",
      "2026-07-27T12:30"
    );
    expect(schedulerMocks.runTaskExecutor).toHaveBeenCalledOnce();
    expect(schedulerMocks.logExecution).toHaveBeenCalledOnce();
  });

  it("skips a slot already claimed by another live instance", async () => {
    schedulerMocks.claimPrivateCandidateJobSlot.mockResolvedValue(false);

    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-27T12:45:00.000Z")
    );

    expect(schedulerMocks.claimPrivateCandidateJobSlot).toHaveBeenCalledWith(
      "task-executor",
      "2026-07-27T12:45"
    );
    expect(schedulerMocks.runTaskExecutor).not.toHaveBeenCalled();
    expect(schedulerMocks.logExecution).not.toHaveBeenCalled();
  });
});
