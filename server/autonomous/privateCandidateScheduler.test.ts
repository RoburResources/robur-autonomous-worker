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
    schedulerMocks.logExecution.mockResolvedValue(undefined);
    schedulerMocks.runTaskExecutor.mockResolvedValue({
      executed: false,
      error: "No DAG-ready pending tasks",
    });
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
    expect(schedulerMocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        details: expect.objectContaining({
          executed: false,
          idle: true,
        }),
      })
    );
  });

  it("records a blocked executor cycle as partial instead of success", async () => {
    schedulerMocks.runTaskExecutor.mockResolvedValue({
      executed: false,
      taskId: 42,
      error: "Confidence gate: evidence insufficient",
    });

    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-27T12:15:00.000Z")
    );

    expect(schedulerMocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "partial",
        errorMessage: "Confidence gate: evidence insufficient",
        details: expect.objectContaining({
          executed: false,
          taskId: 42,
          idle: false,
        }),
      })
    );
  });

  it("records an executed task failure as partial instead of success", async () => {
    schedulerMocks.runTaskExecutor.mockResolvedValue({
      executed: true,
      taskId: 43,
      succeeded: false,
      error: "Research verification did not pass",
    });

    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-27T12:00:00.000Z")
    );

    expect(schedulerMocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "private_candidate_task_executor_cycle",
        outcome: "partial",
        errorMessage: "Research verification did not pass",
        details: expect.objectContaining({
          executed: true,
          succeeded: false,
          taskId: 43,
        }),
      })
    );
  });

  it("bounds duplicated task failure text in scheduler receipts", async () => {
    const longFailure = `Research verification did not pass: ${"evidence ".repeat(400)}`;
    schedulerMocks.runTaskExecutor.mockResolvedValue({
      executed: true,
      taskId: 74,
      succeeded: false,
      error: longFailure,
    });

    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-27T13:15:00.000Z")
    );

    const receipt = schedulerMocks.logExecution.mock.calls[0][0];
    expect(receipt.errorMessage.length).toBeLessThanOrEqual(1_000);
    expect(receipt.errorMessage).toMatch(/\[truncated\]$/);
    expect(receipt.details.error).toBe(receipt.errorMessage);
    expect(receipt.details.error).not.toContain(longFailure);
  });

  it("durably records a thrown executor job as failure", async () => {
    schedulerMocks.runTaskExecutor.mockRejectedValue(
      new Error("database connection lost")
    );

    await runPrivateCandidateSchedulerTick(
      new Date("2026-07-28T12:15:00.000Z")
    );

    expect(schedulerMocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "private_candidate_task_executor_cycle",
        outcome: "failure",
        errorMessage: "database connection lost",
        details: expect.objectContaining({
          slot: "2026-07-28T12:15",
          containment: "internal-only",
        }),
      })
    );
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
