import { describe, expect, it, vi } from "vitest";
import {
  applyRetellTaskCallback,
  getRetellProviderPendingTasks,
  getTaskByExternalProviderReceipt,
} from "./db";

function callbackHarness(affectedRows = 1) {
  const where = vi.fn().mockResolvedValue([{ affectedRows }]);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { database: { update }, update, set, where };
}

function lookupHarness(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { database: { select }, select, from, where, limit };
}

describe("Retell provider callback correlation", () => {
  it("selects only bounded stale provider-pending Retell tasks", async () => {
    const tasks = [{ id: 42 }];
    const limit = vi.fn().mockResolvedValue(tasks);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(
      getRetellProviderPendingTasks(
        new Date("2026-07-30T00:00:00.000Z"),
        25,
        { select } as never
      )
    ).resolves.toEqual(tasks);
    expect(where).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(25);
  });

  it("rejects unbounded Retell-pending queries without touching the database", async () => {
    const select = vi.fn();

    await expect(
      getRetellProviderPendingTasks(
        new Date("invalid"),
        101,
        { select } as never
      )
    ).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("moves an exact provider-pending task to completed from analyzed truth", async () => {
    const harness = callbackHarness();
    const at = new Date("2026-07-30T00:00:00.000Z");

    await expect(
      applyRetellTaskCallback(
        42,
        "call_12345678",
        "completed",
        {
          eventType: "call_analyzed",
          callSuccessful: true,
          callSummary: "The approved objective was achieved.",
          userSentiment: "Positive",
        },
        at,
        harness.database as never
      )
    ).resolves.toEqual({ outcome: "updated", status: "completed" });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        completedAt: at,
        resultSummary: expect.stringContaining("completed successfully"),
      })
    );
  });

  it("keeps call-ended nonterminal until post-call analysis arrives", async () => {
    const harness = callbackHarness();

    await expect(
      applyRetellTaskCallback(
        42,
        "call_12345678",
        "call_ended",
        {
          eventType: "call_ended",
          disconnectionReason: "user_hangup",
        },
        new Date("2026-07-30T00:00:00.000Z"),
        harness.database as never
      )
    ).resolves.toEqual({ outcome: "updated", status: "in_progress" });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "in_progress",
        completedAt: null,
        resultSummary: expect.stringContaining("awaiting post-call analysis"),
      })
    );
  });

  it("holds missing terminal truth for owner reconciliation", async () => {
    const harness = callbackHarness();

    await expect(
      applyRetellTaskCallback(
        42,
        "call_12345678",
        "reconciliation_required",
        { eventType: "call_analyzed" },
        new Date("2026-07-30T00:00:00.000Z"),
        harness.database as never
      )
    ).resolves.toEqual({
      outcome: "updated",
      status: "awaiting_approval",
    });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "awaiting_approval",
        completedAt: null,
        resultSummary: expect.stringContaining("reconciliation"),
      })
    );
  });

  it("reports stale when the exact pending fence no longer matches", async () => {
    const harness = callbackHarness(0);

    await expect(
      applyRetellTaskCallback(
        42,
        "call_12345678",
        "failed",
        {
          eventType: "call_analyzed",
          callSuccessful: false,
        },
        new Date("2026-07-30T00:00:00.000Z"),
        harness.database as never
      )
    ).resolves.toEqual({ outcome: "stale" });
  });

  it("rejects a non-unique provider receipt correlation", async () => {
    const harness = lookupHarness([{ id: 1 }, { id: 2 }]);

    await expect(
      getTaskByExternalProviderReceipt(
        "retell",
        "call_12345678",
        harness.database as never
      )
    ).rejects.toThrow("not uniquely correlated");
  });
});
