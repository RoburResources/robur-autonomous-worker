import { describe, expect, it } from "vitest";

import {
  mergeDailyTaskActivity,
  withTaskActivity,
  withTaskStatusTimestamp,
} from "./db";

describe("source-derived daily task metrics", () => {
  it("replaces stale stored task counters while preserving non-task metrics", () => {
    expect(
      withTaskActivity(
        {
          id: 7,
          date: "2026-07-29",
          tasksGenerated: 0,
          tasksCompleted: 1,
          tasksFailed: 1,
          callsMade: 0,
          emailsSent: 0,
          smsSent: 0,
          apiSpendCents: 488,
          successRate: "0.9000",
          createdAt: new Date("2026-07-29T00:00:00.000Z"),
        },
        "2026-07-29",
        {
          tasksGenerated: 20,
          tasksCompleted: 71,
          tasksFailed: 3,
        }
      )
    ).toEqual({
      id: 7,
      date: "2026-07-29",
      tasksGenerated: 20,
      tasksCompleted: 71,
      tasksFailed: 3,
      callsMade: 0,
      emailsSent: 0,
      smsSent: 0,
      apiSpendCents: 488,
      successRate: "0.9000",
      createdAt: new Date("2026-07-29T00:00:00.000Z"),
    });
  });

  it("returns a complete zero-default row when no stored metric exists", () => {
    expect(withTaskActivity(undefined, "2026-07-30", undefined)).toEqual({
      date: "2026-07-30",
      id: 0,
      tasksGenerated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      callsMade: 0,
      emailsSent: 0,
      smsSent: 0,
      apiSpendCents: 0,
      successRate: null,
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
    });
  });

  it("merges bounded database aggregates by UTC day", () => {
    const activity = mergeDailyTaskActivity(
      [
        { date: "2026-07-29", count: 1 },
        { date: "2026-07-30", count: "2" },
      ],
      [
        { date: "2026-07-29", count: 3 },
        { date: "2026-07-30", count: "4" },
      ],
      [
        { date: "2026-07-29", count: 5 },
        { date: "2026-07-30", count: "6" },
      ]
    );

    expect(activity.get("2026-07-29")).toEqual({
      tasksGenerated: 1,
      tasksCompleted: 3,
      tasksFailed: 5,
    });
    expect(activity.get("2026-07-30")).toEqual({
      tasksGenerated: 2,
      tasksCompleted: 4,
      tasksFailed: 6,
    });
  });

  it("ignores malformed database aggregate rows", () => {
    const activity = mergeDailyTaskActivity(
      [
        { date: null, count: 10 },
        { date: "not-a-day", count: 10 },
        { date: "2026-07-30", count: -1 },
      ],
      [{ date: "2026-07-30", count: "not-a-number" }],
      []
    );

    expect(activity.size).toBe(0);
  });

  it("sets terminal timestamps and clears them when work is reopened", () => {
    const now = new Date("2026-07-30T00:05:00.000Z");

    expect(withTaskStatusTimestamp({ status: "completed" }, now)).toEqual({
      status: "completed",
      completedAt: now,
    });
    expect(withTaskStatusTimestamp({ status: "failed" }, now)).toEqual({
      status: "failed",
      completedAt: now,
    });
    expect(
      withTaskStatusTimestamp(
        { status: "pending", completedAt: new Date("2026-07-29T00:00:00Z") },
        now
      )
    ).toEqual({
      status: "pending",
      completedAt: null,
    });
    expect(withTaskStatusTimestamp({ priorityScore: 70 }, now)).toEqual({
      priorityScore: 70,
    });
  });
});
