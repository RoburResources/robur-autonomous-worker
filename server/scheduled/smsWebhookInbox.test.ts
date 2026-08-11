import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getDb: vi.fn(),
  getTaskById: vi.fn(),
  hasExactOwnerTaskStatusAudit: vi.fn(),
  logExecutionOnce: vi.fn(),
  updateTaskByOwnerWithAudit: vi.fn(),
}));
const twilioMocks = vi.hoisted(() => ({ sendSMS: vi.fn() }));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerEnvironmentGate: vi.fn(),
  getLegacyWorkerRuntimeGate: vi.fn(),
  pauseLegacyWorker: vi.fn(),
  resumeLegacyWorkerByVerifiedOwner: vi.fn(),
}));
const conversationMocks = vi.hoisted(() => ({
  planConversationalSMS: vi.fn(),
  applyConversationalSmsPlan: vi.fn(),
}));

vi.mock("../db", () => ({
  ...dbMocks,
  isMysqlDuplicateKeyError: (error: unknown) =>
    (error as any)?.code === "ER_DUP_ENTRY" ||
    (error as any)?.errno === 1062,
}));
vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("./smsConversation", async importOriginal => {
  const actual = await importOriginal<typeof import("./smsConversation")>();
  return {
    ...actual,
    planConversationalSMS: conversationMocks.planConversationalSMS,
    applyConversationalSmsPlan:
      conversationMocks.applyConversationalSmsPlan,
  };
});

import {
  applySignedSmsControl,
  drainInboundSmsInbox,
  claimInboundSmsInbox,
  completeInboundSmsInbox,
  deferInboundSmsInbox,
  enqueueInboundSms,
  nextInboundSmsInboxKey,
  persistInboundSmsResponseReceipt,
  processInboundSmsClaim,
  releaseInboundSmsInboxForRetry,
  smsWorkProductSchema,
  stageInboundSmsWorkProduct,
  terminalizeInboundSmsInbox,
} from "./smsWebhookInbox";

const now = new Date("2026-07-30T00:00:00.000Z");
const key = "b".repeat(64);
const token = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const payload = {
  from: "+61400000000",
  to: "+61411111111",
  accountSid: `AC${"a".repeat(32)}`,
  message: "STATUS",
  messageSid: `SM${"0".repeat(32)}`,
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
  affectedRows?: number;
  events?: string[];
  beforeSet?: (
    value: Record<string, unknown>,
    rows: Array<Record<string, any>>
  ) => void;
}) {
  const stateRows = (options?.rows || []).map(value => ({
    ...value,
    ...(value.workProduct &&
    typeof value.workProduct === "object" &&
    !Array.isArray(value.workProduct)
      ? { workProduct: { ...value.workProduct } }
      : {}),
  }));
  let providerInsertAttempted = false;
  const onDuplicateKeyUpdate = vi.fn(async () => [{ affectedRows: 1 }]);
  const values = vi.fn((value: Record<string, unknown>) => {
    if ("provider" in value && !providerInsertAttempted) {
      providerInsertAttempted = true;
      if (options?.insertError) throw options.insertError;
    }
    options?.events?.push(
      "workProduct" in value ? "stage-plan" : "database-write"
    );
    return { onDuplicateKeyUpdate };
  });
  const insert = vi.fn(() => ({ values }));
  const selectedRows = () =>
    stateRows.map(value => ({
      ...value,
      ...(value.workProduct &&
      typeof value.workProduct === "object" &&
      !Array.isArray(value.workProduct)
        ? { workProduct: { ...value.workProduct } }
        : {}),
    }));
  const limit = vi.fn(() => {
    const result = Promise.resolve(selectedRows()) as Promise<
      Array<Record<string, any>>
    > & { for: (lock: string) => Promise<Array<Record<string, any>>> };
    result.for = vi.fn(async () => selectedRows());
    return result;
  });
  const orderBy = vi.fn(() => ({ limit }));
  const whereForSelect = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where: whereForSelect }));
  const select = vi.fn(() => ({ from }));
  const whereForUpdate = vi
    .fn()
    .mockResolvedValue([{ affectedRows: options?.affectedRows ?? 1 }]);
  const set = vi.fn((value: Record<string, unknown>) => {
    options?.beforeSet?.(value, stateRows);
    if (stateRows[0]) Object.assign(stateRows[0], value);
    options?.events?.push(
      "workProduct" in value ? "stage-plan" : `state:${value.state || "update"}`
    );
    return { where: whereForUpdate };
  });
  const update = vi.fn(() => ({ set }));
  const database: any = {
    insert,
    select,
    update,
    transaction: vi.fn(async (callback: (tx: any) => unknown) =>
      callback(database)
    ),
  };
  return {
    database,
    insert,
    values,
    onDuplicateKeyUpdate,
    update,
    set,
    whereForUpdate,
  };
}

function row(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    provider: "twilio_sms",
    eventKey: key,
    eventType: "sms_command",
    externalId: payload.messageSid,
    payloadDigest: digest,
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

function workProduct(
  overrides?: Record<string, unknown>
) {
  return smsWorkProductSchema.parse({
    version: 1,
    commandKind: "status",
    effectState: "applied",
    reply: "[Addison] System: paused",
    responseState: "planned",
    ...overrides,
  });
}

function controlHarness(input: {
  commandKey: string;
  commandKind: "start" | "stop";
  latestKey: string;
  latestCommand: "START" | "STOP";
  storedToken?: string;
}) {
  const pendingProduct = workProduct({
    commandKind: input.commandKind,
    effectState: "pending",
    reply:
      input.commandKind === "stop"
        ? "[Addison] System paused."
        : undefined,
    responseState: "none",
  });
  const selectedRows = [
    [
      row({
        eventKey: input.commandKey,
        state: "processing",
        leaseToken: input.storedToken ?? token,
        workProduct: pendingProduct,
      }),
    ],
    [
      {
        value: JSON.stringify({
          version: 1,
          eventKey: input.latestKey,
          command: input.latestCommand,
          acceptedAt: now.toISOString(),
        }),
      },
    ],
  ];
  const forUpdate = vi.fn(async () => selectedRows.shift() || []);
  const limit = vi.fn(() => ({ for: forUpdate }));
  const whereForSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereForSelect }));
  const select = vi.fn(() => ({ from }));
  const onDuplicateKeyUpdate = vi.fn(async () => [{ affectedRows: 1 }]);
  const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
  const insert = vi.fn(() => ({ values }));
  const whereForUpdate = vi.fn(async () => [{ affectedRows: 1 }]);
  const set = vi.fn(() => ({ where: whereForUpdate }));
  const update = vi.fn(() => ({ set }));
  const database: any = {
    select,
    insert,
    update,
    transaction: vi.fn(async (callback: (tx: any) => unknown) =>
      callback(database)
    ),
  };
  return {
    database,
    pendingProduct,
    values,
    set,
  };
}

describe("Twilio durable SMS inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    dbMocks.getConfig.mockResolvedValue("paused");
    dbMocks.logExecutionOnce.mockResolvedValue(true);
    dbMocks.hasExactOwnerTaskStatusAudit.mockResolvedValue(false);
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: true,
    });
    gateMocks.getLegacyWorkerEnvironmentGate.mockReturnValue({
      allowed: true,
    });
    gateMocks.pauseLegacyWorker.mockResolvedValue(undefined);
    gateMocks.resumeLegacyWorkerByVerifiedOwner.mockResolvedValue(undefined);
    conversationMocks.planConversationalSMS.mockResolvedValue({
      version: 1,
      kind: "task_creation",
      tasks: [
        {
          description: "Research a bounded owner-requested topic",
          actionType: "web_research",
          priorityScore: 80,
        },
      ],
      reply: "Instruction recorded.",
      fallback: false,
    });
    conversationMocks.applyConversationalSmsPlan.mockResolvedValue(
      "[Addison] Instruction recorded."
    );
    twilioMocks.sendSMS.mockResolvedValue({
      sid: `SM${"f".repeat(32)}`,
      status: "queued",
    });
  });

  it("never drains queued provider messages inside the private candidate", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");
    vi.stubEnv("OWNER_SMS_COMMAND_CHANNEL_CERTIFIED", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "auth-token");
    vi.stubEnv("TWILIO_PHONE_NUMBER", payload.to);
    vi.stubEnv("OWNER_PHONE_E164", payload.from);
    vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", "https://example.test/api/webhooks/sms");
    vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", "https://example.test/api/twilio/status");
    vi.stubEnv("TWILIO_SMS_FALLBACK_URL", "https://example.test/api/twilio/fallback");
    vi.stubEnv("TWILIO_MESSAGE_STATUS_CALLBACK_CERTIFIED", "true");
    vi.stubEnv("TWILIO_SMS_RETRY_POLICY", "disabled");

    await expect(drainInboundSmsInbox()).resolves.toBe(0);

    expect(dbMocks.getDb).not.toHaveBeenCalled();
  });

  it("commits a bounded authenticated delivery", async () => {
    const harness = inboxHarness();

    await expect(
      enqueueInboundSms(
        payload,
        digest,
        now,
        harness.database
      )
    ).resolves.toMatchObject({
      disposition: "accepted",
      created: true,
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "twilio_sms",
        state: "pending",
        payloadDigest: digest,
      })
    );
  });

  it("commits STOP and all pause rows in one transaction", async () => {
    const harness = inboxHarness();

    await enqueueInboundSms(
      { ...payload, message: "STOP" },
      digest,
      now,
      harness.database
    );

    expect(harness.database.transaction).toHaveBeenCalledTimes(1);
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "twilio_sms",
        eventType: "sms_stop",
      })
    );
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kill_switch_active",
        value: "true",
      })
    );
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "system_status",
        value: "paused",
      })
    );
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "kill_switch_activated",
      })
    );
  });

  it("deduplicates an identical retry without reapplying STOP", async () => {
    const harness = inboxHarness({
      insertError: duplicateError(),
      rows: [
        row({
          eventType: "sms_stop",
          payload: { ...payload, message: "STOP" },
        }),
      ],
    });

    await expect(
      enqueueInboundSms(
        { ...payload, message: "STOP" },
        digest,
        now,
        harness.database
      )
    ).resolves.toMatchObject({
      disposition: "accepted",
      created: false,
    });
    expect(harness.onDuplicateKeyUpdate).not.toHaveBeenCalled();
  });

  it("quarantines a same-SID changed-payload replay", async () => {
    const harness = inboxHarness({
      insertError: duplicateError(),
      rows: [row({ payloadDigest: "c".repeat(64) })],
    });

    await expect(
      enqueueInboundSms(payload, digest, now, harness.database)
    ).resolves.toMatchObject({ disposition: "conflict" });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        leaseToken: null,
      })
    );
  });

  it("claims one pending delivery with an exact fenced token", async () => {
    const harness = inboxHarness({ rows: [row()] });

    await expect(
      claimInboundSmsInbox(key, now, 60_000, harness.database)
    ).resolves.toMatchObject({
      disposition: "acquired",
      attemptCount: 1,
      payload,
      token: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "processing",
        attemptCount: 1,
      })
    );
  });

  it("returns the post-CAS dispatch marker staged during lease recovery", async () => {
    const planned = workProduct();
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          leaseUntil: new Date("2026-07-29T23:59:00.000Z"),
          attemptCount: 1,
          workProduct: planned,
        }),
      ],
      beforeSet: (value, rows) => {
        if (typeof value.leaseToken === "string" && rows[0]) {
          rows[0].workProduct = {
            ...planned,
            responseState: "started",
          };
        }
      },
    });

    await expect(
      claimInboundSmsInbox(key, now, 60_000, harness.database)
    ).resolves.toMatchObject({
      disposition: "acquired",
      attemptCount: 2,
      workProduct: expect.objectContaining({
        responseState: "started",
      }),
    });
  });

  it("selects safety commands from their own unbounded queue class", async () => {
    const limit = vi.fn().mockResolvedValueOnce([{ key: "c".repeat(64) }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(
      nextInboundSmsInboxKey({ select } as never)
    ).resolves.toBe("c".repeat(64));
    expect(limit).toHaveBeenCalledWith(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("falls through safety and read-only classes before normal work", async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ key: "d".repeat(64) }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(
      nextInboundSmsInboxKey({ select } as never)
    ).resolves.toBe("d".repeat(64));
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("never steals a live processing lease", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          leaseUntil: new Date("2026-07-30T00:01:00.000Z"),
          attemptCount: 1,
        }),
      ],
    });

    await expect(
      claimInboundSmsInbox(key, now, 60_000, harness.database)
    ).resolves.toEqual({ disposition: "processing" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("terminalizes an expired fifth lease without creating attempt six", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          leaseUntil: new Date("2026-07-29T23:59:00.000Z"),
          attemptCount: 5,
        }),
      ],
    });

    await expect(
      claimInboundSmsInbox(key, now, 60_000, harness.database)
    ).resolves.toEqual({ disposition: "terminal_failure" });
    expect(JSON.stringify(harness.set.mock.calls)).not.toContain(
      '"attemptCount":6'
    );
  });

  it("defers paused work without consuming a retry attempt", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          attemptCount: 3,
        }),
      ],
    });

    await expect(
      deferInboundSmsInbox(
        key,
        token,
        "paused",
        now,
        harness.database
      )
    ).resolves.toBe(true);
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "pending",
        attemptCount: 2,
      })
    );
  });

  it("stages, completes, and terminalizes only under the active token", async () => {
    const harness = inboxHarness();
    const product = workProduct();

    await expect(
      stageInboundSmsWorkProduct(
        key,
        token,
        product,
        harness.database
      )
    ).resolves.toBe(true);
    await expect(
      completeInboundSmsInbox(key, token, now, harness.database)
    ).resolves.toBe(true);
    await expect(
      terminalizeInboundSmsInbox(
        key,
        token,
        "unknown outcome",
        workProduct({ responseState: "reconciliation_required" }),
        now,
        harness.database
      )
    ).resolves.toBe(true);
    expect(harness.update).toHaveBeenCalledTimes(3);
  });

  it("moves a failed fifth attempt to terminal failure", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          attemptCount: 5,
        }),
      ],
    });

    await expect(
      releaseInboundSmsInboxForRetry(
        key,
        token,
        "permanent failure",
        now,
        harness.database
      )
    ).resolves.toEqual({ released: true, terminal: true });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        nextAttemptAt: null,
      })
    );
  });

  it("stages a single model plan before applying it", async () => {
    const events: string[] = [];
    const harness = inboxHarness({ events });
    dbMocks.getDb.mockResolvedValue(harness.database);
    conversationMocks.applyConversationalSmsPlan.mockImplementation(
      async () => {
        events.push("apply-plan");
        return "[Addison] Instruction recorded.";
      }
    );
    const naturalPayload = {
      ...payload,
      message: "Research a bounded topic",
    };

    await processInboundSmsClaim({
      disposition: "acquired",
      key,
      token,
      payload: naturalPayload,
      attemptCount: 1,
    });

    expect(conversationMocks.planConversationalSMS).toHaveBeenCalledTimes(1);
    expect(events.indexOf("stage-plan")).toBeLessThan(
      events.indexOf("apply-plan")
    );
    expect(conversationMocks.applyConversationalSmsPlan).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      naturalPayload.message,
      `twilio:${payload.messageSid}`
    );
  });

  it("records a receipt before completion and sends only once", async () => {
    const harness = inboxHarness({
      rows: [
        row({
          state: "processing",
          leaseToken: token,
          workProduct: workProduct(),
        }),
      ],
    });
    dbMocks.getDb.mockResolvedValue(harness.database);

    await processInboundSmsClaim({
      disposition: "acquired",
      key,
      token,
      payload,
      workProduct: workProduct(),
      attemptCount: 1,
    });

    expect(twilioMocks.sendSMS).toHaveBeenCalledTimes(1);
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        workProduct: expect.objectContaining({ responseState: "started" }),
      })
    );
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        workProduct: expect.objectContaining({
          responseState: "accepted",
          responseReceipt: expect.objectContaining({
            sid: `SM${"f".repeat(32)}`,
          }),
        }),
      })
    );
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "completed",
        workProduct: expect.objectContaining({ responseState: "accepted" }),
      })
    );
  });

  it("preserves a real provider receipt after the worker lease is lost", async () => {
    const started = workProduct({ responseState: "started" });
    const harness = inboxHarness({
      rows: [
        row({
          state: "terminal_failure",
          leaseToken: null,
          workProduct: {
            ...started,
            responseState: "reconciliation_required",
          },
        }),
      ],
    });

    await expect(
      persistInboundSmsResponseReceipt(
        key,
        started,
        { sid: `SM${"f".repeat(32)}`, status: "queued" },
        now,
        harness.database
      )
    ).resolves.toBe(true);
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "completed",
        failedAt: null,
        workProduct: expect.objectContaining({
          responseState: "accepted",
          responseReceipt: {
            sid: `SM${"f".repeat(32)}`,
            status: "queued",
          },
        }),
      })
    );
  });

  it("matches receipt identity across normalized nested JSON key order", async () => {
    const expected = smsWorkProductSchema.parse({
      version: 1,
      commandKind: "conversation",
      effectState: "applied",
      reply: "[Addison] Instruction recorded.",
      conversationPlan: {
        version: 1,
        kind: "task_creation",
        tasks: [
          {
            description: "Research the exact owner-requested bounded topic",
            actionType: "web_research",
            priorityScore: 80,
            actionPayload: { zeta: "last", alpha: "first" },
          },
        ],
        reply: "Instruction recorded.",
        fallback: false,
      },
      responseState: "started",
    });
    const normalized = smsWorkProductSchema.parse({
      ...expected,
      conversationPlan: {
        ...expected.conversationPlan!,
        tasks: [
          {
            ...expected.conversationPlan!.tasks[0],
            actionPayload: { alpha: "first", zeta: "last" },
          },
        ],
      },
      responseState: "reconciliation_required",
    });
    const harness = inboxHarness({
      rows: [
        row({
          state: "terminal_failure",
          workProduct: normalized,
        }),
      ],
    });

    await expect(
      persistInboundSmsResponseReceipt(
        key,
        expected,
        { sid: `SM${"e".repeat(32)}`, status: "queued" },
        now,
        harness.database
      )
    ).resolves.toBe(true);
  });

  it("never resumes an earlier START after a later STOP is durable", async () => {
    const startKey = "1".repeat(64);
    const stopKey = "2".repeat(64);
    const harness = controlHarness({
      commandKey: startKey,
      commandKind: "start",
      latestKey: stopKey,
      latestCommand: "STOP",
    });
    dbMocks.getDb.mockResolvedValue(harness.database);

    await expect(
      applySignedSmsControl(
        {
          key: startKey,
          token,
          payload: { ...payload, message: "START" },
        },
        harness.pendingProduct
      )
    ).resolves.toMatchObject({
      effectState: "applied",
      reply: expect.stringContaining("owner dashboard"),
    });

    expect(harness.values).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kill_switch_active",
        value: "false",
      })
    );
  });

  it("never resumes from SMS START even when it is the latest active token", async () => {
    const startKey = "3".repeat(64);
    const harness = controlHarness({
      commandKey: startKey,
      commandKind: "start",
      latestKey: startKey,
      latestCommand: "START",
    });
    dbMocks.getDb.mockResolvedValue(harness.database);
    vi.stubEnv("OWNER_PHONE_E164", payload.from);

    await applySignedSmsControl(
      {
        key: startKey,
        token,
        payload: { ...payload, message: "START" },
      },
      harness.pendingProduct
    );

    expect(harness.values).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kill_switch_active",
        value: "false",
      })
    );
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        workProduct: expect.objectContaining({
          effectState: "applied",
          responseState: "planned",
          reply: expect.stringContaining("owner dashboard"),
        }),
      })
    );
  });

  it("consumes a closed-gate START without seeding a later resume", async () => {
    const startKey = "5".repeat(64);
    const harness = controlHarness({
      commandKey: startKey,
      commandKind: "start",
      latestKey: startKey,
      latestCommand: "START",
    });
    dbMocks.getDb.mockResolvedValue(harness.database);
    vi.stubEnv("OWNER_PHONE_E164", payload.from);
    gateMocks.getLegacyWorkerEnvironmentGate.mockReturnValue({
      allowed: false,
      reason: "Legacy worker deployment opt-in is not enabled",
    });

    await expect(
      applySignedSmsControl(
        {
          key: startKey,
          token,
          payload: { ...payload, message: "START" },
        },
        harness.pendingProduct
      )
    ).resolves.toMatchObject({
      effectState: "applied",
      reply: expect.stringContaining("owner dashboard"),
    });
    expect(harness.values).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kill_switch_active",
        value: "false",
      })
    );
  });

  it("cannot apply a control after its inbox token was reclaimed", async () => {
    const startKey = "4".repeat(64);
    const harness = controlHarness({
      commandKey: startKey,
      commandKind: "start",
      latestKey: startKey,
      latestCommand: "START",
      storedToken: "99999999-9999-4999-8999-999999999999",
    });
    dbMocks.getDb.mockResolvedValue(harness.database);
    vi.stubEnv("OWNER_PHONE_E164", payload.from);

    await expect(
      applySignedSmsControl(
        {
          key: startKey,
          token,
          payload: { ...payload, message: "START" },
        },
        harness.pendingProduct
      )
    ).rejects.toThrow("lost its exact active lease");
    expect(harness.values).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: "kill_switch_active",
        value: "false",
      })
    );
  });

  it("never blindly resends after a crash beyond the dispatch marker", async () => {
    const harness = inboxHarness();
    dbMocks.getDb.mockResolvedValue(harness.database);

    await processInboundSmsClaim({
      disposition: "acquired",
      key,
      token,
      payload,
      workProduct: workProduct({ responseState: "started" }),
      attemptCount: 2,
    });

    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        workProduct: expect.objectContaining({
          responseState: "reconciliation_required",
        }),
      })
    );
  });

  it("terminalizes an outbound timeout and blocks automatic resend", async () => {
    const harness = inboxHarness();
    dbMocks.getDb.mockResolvedValue(harness.database);
    twilioMocks.sendSMS.mockRejectedValue(new Error("provider timeout"));

    await processInboundSmsClaim({
      disposition: "acquired",
      key,
      token,
      payload,
      workProduct: workProduct(),
      attemptCount: 1,
    });

    expect(twilioMocks.sendSMS).toHaveBeenCalledTimes(1);
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "terminal_failure",
        lastError: "provider timeout",
      })
    );
  });

  it("completes a recovered accepted receipt without resending", async () => {
    const harness = inboxHarness();
    dbMocks.getDb.mockResolvedValue(harness.database);

    await processInboundSmsClaim({
      disposition: "acquired",
      key,
      token,
      payload,
      workProduct: workProduct({
        responseState: "accepted",
        responseReceipt: {
          sid: `SM${"f".repeat(32)}`,
          status: "queued",
        },
      }),
      attemptCount: 2,
    });

    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed" })
    );
  });
});
