import { describe, expect, it } from "vitest";
import { createTaskOnce } from "./db";

describe("createTaskOnce", () => {
  it("atomically creates one task for repeated idempotency claims", async () => {
    let claimExists = false;
    let taskInsertCount = 0;
    const tx = {
      insert: () => ({
        values: async () => {
          if (!claimExists) {
            claimExists = true;
            return [{ insertId: 1 }];
          }
          if (taskInsertCount === 0) {
            taskInsertCount += 1;
            return [{ insertId: 77 }];
          }
          const error = Object.assign(new Error("duplicate"), {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          });
          throw error;
        },
      }),
    };
    const database = {
      transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
        callback(tx),
    };
    const task = {
      description: "Queue one bounded briefing task for owner approval.",
      actionType: "outbound_call",
      priorityScore: 90,
      source: "scheduled_briefing",
    };

    const first = await createTaskOnce(
      "scheduled_briefing:morning:2026-07-30",
      task,
      database as never
    );
    const second = await createTaskOnce(
      "scheduled_briefing:morning:2026-07-30",
      task,
      database as never
    );

    expect(first).toEqual({ created: true, taskId: 77 });
    expect(second).toEqual({ created: false });
    expect(taskInsertCount).toBe(1);
  });
});
