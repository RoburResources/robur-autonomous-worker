import { describe, expect, it } from "vitest";
import { getPrivateCandidateDueJobs } from "./privateCandidateScheduler";

describe("private candidate scheduler", () => {
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
});
