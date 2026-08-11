import { describe, expect, it, vi } from "vitest";
import {
  claimRetellWebhook,
  completeRetellWebhook,
  enqueueRetellWebhook,
  releaseRetellWebhookForRetry,
  stageRetellWebhookWorkProduct,
} from "./retellWebhookInbox";

const now = new Date("2026-07-30T00:00:00.000Z");
const callId = "call_12345678";
const payloadDigest = "a".repeat(64);
const payload = {
  event: "call_ended",
  call: { call_id: callId, agent_id: "agent_12345678" },
};

function duplicateError() {
  return Object.assign(new Error("duplicate"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
  });
}

function inboxHarness(options?: {
  insertError?: Error;
  rows?: Array<Record<string, any>>;
  rowSnapshots?: Array<
    Array<Record<string, any>> | (() => Array<Record<string, any>>)
  >;
  affectedRows?: number;
}) {
  const values = vi.fn(async () => {
    if (options?.insertError) throw options.insertError;
    return [{ insertId: 1 }];
  });
  const insert = vi.fn(() => ({ values }));
  let readIndex = 0;
  const limit = vi.fn(async () => {
    if (options?.rowSnapshots) {
      const snapshotOrFactory =
        options.rowSnapshots[
          Math.min(readIndex, options.rowSnapshots.length - 1)
        ] || [];
      readIndex += 1;
      return typeof snapshotOrFactory === "function"
        ? snapshotOrFactory()
        : snapshotOrFactory;
    }
    return options?.rows || [];
  });
  const orderBy = vi.fn(() => ({ limit }));
  const whereForSelect = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: whereForSelect }));
  const select = vi.fn(() => ({ from }));
  const whereForUpdate = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options?.affectedRows ?? 1 }]);
  const set = vi.fn(() => ({ where: whereForUpdate }));
  const update = vi.fn(() => ({ set }));
  return {
    database: { insert, select, update },
    values,
    insert,
    select,
    update,
    set,
    whereForUpdate,
  };
}

function row(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    provider: "retell",
    eventKey: "b".repeat(64),
    eventType: "call_ended",
    externalId: callId,
    payloadDigest,
    payload,
    state: "pending",
    attemptCount: 0,
    leaseToken: null,
    leaseUntil: null,
    nextAttemptAt: null,
    workProduct: null,
    lastError: null,
    receivedAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
    ...overrides,
  };
}

describe("Retell durable webhook inbox", () => {
  it("commits a bounded event before it can be acknowledged", async () => {
    const harness = inboxHarness();

    await expect(
      enqueueRetellWebhook(
        "call_ended",
        callId,
        payloadDigest,
        payload,
        now,
        harness.database as never
      )
    ).resolves.toMatchObject({
      disposition: "accepted",
      created: true,
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "retell",
        payloadDigest,
        state: "pending",
      })
    );
  });

  it("deduplicates an identical provider retry", async () => {
    const harness = inboxHarness({
      insertError: duplicateError(),
      rows: [row()],
    });

    await expect(
      enqueueRetellWebhook(
        "call_ended",
        callId,
        payloadDigest,
        payload,
        now,
        harness.database as never
      )
    ).resolves.toMatchObject({
      disposition: "accepted",
      created: false,
    });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("durably quarantines the same event identity with a changed payload", async () => {
    const harness = inboxHarness({
      insertError: duplicateError(),
      rows: [row({ payloadDigest: "c".repeat(64) })],
    });

    await expect(
      enqueueRetellWebhook(
        "call_ended",
        callId,
        payloadDigest,
        payload,
        now,
        harness.database as never
      )
    ).resolves.toMatchObject({ disposition: "conflict" });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        leaseToken: null,
      })
    );
  });

  it("claims one pending row with a fenced token", async () => {
    let harness!: ReturnType<typeof inboxHarness>;
    harness = inboxHarness({
      rowSnapshots: [
        [row()],
        () => [
          row({
            state: "processing",
            leaseToken: harness.set.mock.calls[0][0].leaseToken,
            leaseUntil: harness.set.mock.calls[0][0].leaseUntil,
            attemptCount: 1,
          }),
        ],
      ],
    });

    await expect(
      claimRetellWebhook(
        "b".repeat(64),
        now,
        60_000,
        harness.database as never
      )
    ).resolves.toMatchObject({
      disposition: "acquired",
      token: expect.any(String),
      attemptCount: 1,
      callId,
    });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "processing",
        attemptCount: 1,
      })
    );
  });

  it("returns the CAS-owned row when a stale worker stages work during takeover", async () => {
    const stalePayload = {
      event: "call_ended",
      call: { call_id: callId, agent_id: "agent_stale1234" },
    };
    const currentPayload = {
      event: "call_ended",
      call: { call_id: callId, agent_id: "agent_current1234" },
    };
    const currentWorkProduct = { disposition: "recorded", tasks: [] };
    let harness!: ReturnType<typeof inboxHarness>;
    harness = inboxHarness({
      rowSnapshots: [
        [row({ payload: stalePayload, workProduct: null })],
        () => [
          row({
            state: "processing",
            leaseToken: harness.set.mock.calls[0][0].leaseToken,
            attemptCount: 1,
            payload: currentPayload,
            workProduct: currentWorkProduct,
          }),
        ],
      ],
    });

    const claim = await claimRetellWebhook(
      "b".repeat(64),
      now,
      60_000,
      harness.database as never
    );

    expect(claim).toMatchObject({
      disposition: "acquired",
      payload: currentPayload,
      workProduct: currentWorkProduct,
      attemptCount: 1,
    });
    expect(harness.select).toHaveBeenCalledTimes(2);
  });

  it("never steals a live processing lease", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: "11111111-1111-4111-8111-111111111111",
          leaseUntil: new Date("2026-07-30T00:01:00.000Z"),
          attemptCount: 1,
        }),
      ],
    });

    await expect(
      claimRetellWebhook(
        "b".repeat(64),
        now,
        60_000,
        harness.database as never
      )
    ).resolves.toEqual({ disposition: "processing" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("terminalizes an expired fifth attempt instead of creating an unreadable sixth", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: "11111111-1111-4111-8111-111111111111",
          leaseUntil: new Date("2026-07-29T23:59:00.000Z"),
          attemptCount: 5,
        }),
      ],
    });

    await expect(
      claimRetellWebhook(
        "b".repeat(64),
        now,
        60_000,
        harness.database as never
      )
    ).resolves.toEqual({ disposition: "terminal_failure" });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        lastError: expect.stringContaining("retry limit"),
      })
    );
    expect(JSON.stringify(harness.set.mock.calls)).not.toContain(
      '"attemptCount":6'
    );
  });

  it("stages and completes only under the exact active lease token", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const harness = inboxHarness({ affectedRows: 1 });

    await expect(
      stageRetellWebhookWorkProduct(
        "b".repeat(64),
        token,
        { tasks: [] },
        harness.database as never
      )
    ).resolves.toBe(true);
    await expect(
      completeRetellWebhook(
        "b".repeat(64),
        token,
        now,
        harness.database as never
      )
    ).resolves.toBe(true);
    expect(harness.update).toHaveBeenCalledTimes(2);
  });

  it("moves a failed fifth attempt to terminal failure without blind replay", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          leaseUntil: new Date("2026-07-30T00:01:00.000Z"),
          attemptCount: 5,
        }),
      ],
    });

    await expect(
      releaseRetellWebhookForRetry(
        "b".repeat(64),
        token,
        "permanent failure",
        now,
        harness.database as never
      )
    ).resolves.toEqual({ released: true, terminal: true });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        nextAttemptAt: null,
      })
    );
  });
});
