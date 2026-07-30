import { describe, expect, it, vi } from "vitest";
import { acquireInboundSms, completeInboundSms } from "./db";

const sid = `SM${"a".repeat(32)}`;
const now = new Date("2026-07-30T00:00:00.000Z");

function duplicateError() {
  return Object.assign(new Error("duplicate"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
  });
}

function leaseHarness(options?: {
  insertError?: Error;
  storedValue?: string;
  affectedRows?: number;
}) {
  const values = vi.fn(async () => {
    if (options?.insertError) throw options.insertError;
    return [{ insertId: 1 }];
  });
  const insert = vi.fn(() => ({ values }));
  const limit = vi.fn(async () =>
    options?.storedValue === undefined
      ? []
      : [{ value: options.storedValue }]
  );
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({ limit }),
    }),
  }));
  const where = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options?.affectedRows ?? 1 }]);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    database: { insert, select, update },
    insert,
    values,
    select,
    update,
    set,
    where,
  };
}

describe("inbound SMS processing lease", () => {
  it("creates a processing lease without persisting the raw Twilio SID", async () => {
    const harness = leaseHarness();

    const result = await acquireInboundSms(
      sid,
      now,
      10 * 60_000,
      harness.database as never
    );

    expect(result).toMatchObject({
      disposition: "acquired",
      token: expect.any(String),
      leaseUntil: "2026-07-30T00:10:00.000Z",
    });
    expect(harness.values).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.values.mock.calls[0][0])).not.toContain(sid);
  });

  it("does not steal a live processing lease", async () => {
    const harness = leaseHarness({
      insertError: duplicateError(),
      storedValue: JSON.stringify({
        version: 1,
        state: "processing",
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: "2026-07-30T00:05:00.000Z",
      }),
    });

    await expect(
      acquireInboundSms(sid, now, 10 * 60_000, harness.database as never)
    ).resolves.toEqual({ disposition: "processing" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease with one conditional update", async () => {
    const harness = leaseHarness({
      insertError: duplicateError(),
      storedValue: JSON.stringify({
        version: 1,
        state: "processing",
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: "2026-07-29T23:59:00.000Z",
      }),
      affectedRows: 1,
    });

    await expect(
      acquireInboundSms(sid, now, 10 * 60_000, harness.database as never)
    ).resolves.toMatchObject({
      disposition: "acquired",
      token: expect.any(String),
      leaseUntil: "2026-07-30T00:10:00.000Z",
    });
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);
  });

  it("treats historical timestamp claims as completed replays", async () => {
    const harness = leaseHarness({
      insertError: duplicateError(),
      storedValue: "2026-07-29T00:00:00.000Z",
    });

    await expect(
      acquireInboundSms(sid, now, 10 * 60_000, harness.database as never)
    ).resolves.toEqual({ disposition: "completed" });
  });

  it("completes only the exact active token with a conditional update", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const harness = leaseHarness({
      storedValue: JSON.stringify({
        version: 1,
        state: "processing",
        token,
        leaseUntil: "2026-07-30T00:05:00.000Z",
      }),
      affectedRows: 1,
    });

    await expect(
      completeInboundSms(sid, token, now, harness.database as never)
    ).resolves.toBe(true);
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.where).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale completion token without writing", async () => {
    const harness = leaseHarness({
      storedValue: JSON.stringify({
        version: 1,
        state: "processing",
        token: "11111111-1111-4111-8111-111111111111",
        leaseUntil: "2026-07-30T00:05:00.000Z",
      }),
    });

    await expect(
      completeInboundSms(
        sid,
        "22222222-2222-4222-8222-222222222222",
        now,
        harness.database as never
      )
    ).resolves.toBe(false);
    expect(harness.update).not.toHaveBeenCalled();
  });
});
