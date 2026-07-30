import { describe, expect, it } from "vitest";
import { requeueStaleInProgressTasks } from "./db";

function recoveryHarness(
  tasks: Array<{ id: number; actionType: string | null }>,
  affectedRows = 1
) {
  const updates: Array<Record<string, unknown>> = [];
  const database = {
    select: () => ({
      from: () => ({
        where: async () => tasks,
      }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: async () => {
          updates.push(data);
          return [{ affectedRows }];
        },
      }),
    }),
  };
  return { database, updates };
}

describe("stale task recovery", () => {
  it("requeues internal work but holds every external-effect type for reconciliation", async () => {
    const harness = recoveryHarness([
      { id: 1, actionType: "web_research" },
      { id: 2, actionType: "outbound_call" },
      { id: 3, actionType: "send_email" },
      { id: 4, actionType: "send_sms" },
    ]);

    const recovered = await requeueStaleInProgressTasks(
      new Date("2026-07-30T00:00:00.000Z"),
      harness.database as never
    );

    expect(recovered).toEqual([
      {
        taskId: 1,
        actionType: "web_research",
        disposition: "requeued",
      },
      {
        taskId: 2,
        actionType: "outbound_call",
        disposition: "held_for_reconciliation",
        approvalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        reconciliationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      {
        taskId: 3,
        actionType: "send_email",
        disposition: "held_for_reconciliation",
        approvalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        reconciliationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
      {
        taskId: 4,
        actionType: "send_sms",
        disposition: "held_for_reconciliation",
        approvalFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        reconciliationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
    expect(harness.updates.map(update => update.status)).toEqual([
      "pending",
      "awaiting_approval",
      "awaiting_approval",
      "awaiting_approval",
    ]);
    expect(harness.updates[0].resultSummary).toContain(
      "Recovered automatically"
    );
    for (const update of harness.updates.slice(1)) {
      expect(update.resultSummary).toContain("unknown provider outcome");
    }
  });

  it("does not report a lease when the fenced update loses the race", async () => {
    const harness = recoveryHarness(
      [{ id: 2, actionType: "send_sms" }],
      0
    );

    await expect(
      requeueStaleInProgressTasks(
        new Date("2026-07-30T00:00:00.000Z"),
        harness.database as never
      )
    ).resolves.toEqual([]);
  });
});
