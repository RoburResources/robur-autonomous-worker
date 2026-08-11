import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  executionLog,
  providerWebhookInbox,
  systemConfig,
} from "../../drizzle/schema";
import {
  getConfig,
  getDb,
  getTaskById,
  hasExactOwnerTaskStatusAudit,
  isMysqlDuplicateKeyError,
  logExecutionOnce,
  updateTaskByOwnerWithAudit,
} from "../db";
import { sendSMS } from "../integrations/twilio";
import {
  getLegacyWorkerRuntimeGate,
} from "../safety/legacyWorkerGate";
import { ownerSmsChannelCertified } from "../safety/smsChannelCertification";
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";
import {
  applyConversationalSmsPlan,
  planConversationalSMS,
  smsConversationPlanSchema,
} from "./smsConversation";

const PROVIDER = "twilio_sms";
const MAX_ATTEMPTS = 5;
const MAX_PAYLOAD_BYTES = 16_000;
const MAX_WORK_PRODUCT_BYTES = 64_000;
const DEFAULT_LEASE_MS = 2 * 60_000;
const EMPTY_TWIML = "<Response></Response>";
const LATEST_SMS_CONTROL_KEY = "sms_latest_signed_control";

type JsonObject = Record<string, unknown>;
type InboxDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const inboundSmsPayloadSchema = z
  .object({
    from: z.string().regex(/^\+[1-9]\d{7,14}$/),
    to: z.string().regex(/^\+[1-9]\d{7,14}$/),
    accountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/),
    message: z.string().trim().min(1).max(1_600),
    messageSid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
  })
  .strict();

const responseReceiptSchema = z
  .object({
    sid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
    status: z.string().min(1).max(64),
  })
  .strict();

export const smsWorkProductSchema = z
  .object({
    version: z.literal(1),
    commandKind: z.enum([
      "stop",
      "start",
      "status",
      "approve",
      "reject",
      "conversation",
    ]),
    effectState: z.enum(["pending", "applied"]),
    reply: z.string().min(1).max(320).optional(),
    conversationPlan: smsConversationPlanSchema.optional(),
    taskId: z.number().int().positive().optional(),
    approvalFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    approvalRequestId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      .optional(),
    responseState: z.enum([
      "none",
      "planned",
      "started",
      "accepted",
      "reconciliation_required",
    ]),
    responseReceipt: responseReceiptSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.responseState === "accepted" &&
      value.responseReceipt === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepted response requires a provider receipt",
      });
    }
    if (
      value.commandKind === "conversation" &&
      value.conversationPlan === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Conversation work requires a staged plan",
      });
    }
  });

export type InboundSmsPayload = z.infer<typeof inboundSmsPayloadSchema>;
export type SmsWorkProduct = z.infer<typeof smsWorkProductSchema>;

export type SmsInboxEnqueueResult =
  | { disposition: "accepted"; key: string; created: boolean }
  | { disposition: "completed"; key: string }
  | { disposition: "terminal_failure"; key: string }
  | { disposition: "conflict"; key: string }
  | { disposition: "invalid" };

export type SmsInboxClaimResult =
  | {
      disposition: "acquired";
      key: string;
      token: string;
      payload: InboundSmsPayload;
      workProduct?: SmsWorkProduct;
      attemptCount: number;
    }
  | {
      disposition:
        | "processing"
        | "completed"
        | "deferred"
        | "terminal_failure"
        | "missing"
        | "invalid";
    };

class SmsProcessingDeferredError extends Error {}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function affectedRows(result: unknown): number {
  const driverResult = (result as any)?.[0] ?? result;
  return Number(
    (driverResult as any)?.affectedRows ??
      (driverResult as any)?.rowsAffected ??
      0
  );
}

function eventKey(messageSid: string): string | null {
  if (!/^SM[a-fA-F0-9]{32}$/.test(messageSid)) return null;
  return createHash("sha256").update(messageSid, "utf8").digest("hex");
}

function classifyEventType(message: string): string {
  const upper = message.toUpperCase().trim();
  if (upper === "STOP") return "sms_stop";
  if (upper === "START") return "sms_start";
  if (upper === "STATUS") return "sms_status";
  if (
    ["TASKS", "QUEUE", "DONE", "COMPLETED", "HELP", "?"].includes(upper)
  ) {
    return "sms_read_only";
  }
  return "sms_command";
}

async function readInboxRow(key: string, db: InboxDatabase) {
  const rows = await db
    .select()
    .from(providerWebhookInbox)
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key)
      )
    )
    .limit(1);
  return rows[0] || null;
}

async function insertControlCommand(
  db: InboxDatabase,
  input: {
    key: string;
    eventType: string;
    payloadDigest: string;
    payload: InboundSmsPayload;
    now: Date;
  }
): Promise<void> {
  const command =
    input.eventType === "sms_stop"
      ? "STOP"
      : input.eventType === "sms_start"
        ? "START"
        : null;
  if (!command) throw new Error("SMS control command is invalid");
  await db.transaction(async tx => {
    await tx.insert(providerWebhookInbox).values({
      provider: PROVIDER,
      eventKey: input.key,
      eventType: input.eventType,
      externalId: input.payload.messageSid,
      payloadDigest: input.payloadDigest,
      payload: input.payload,
      state: "pending",
      attemptCount: 0,
      receivedAt: input.now,
    });
    if (command === "STOP") {
      await tx
        .insert(systemConfig)
        .values({
          key: LATEST_SMS_CONTROL_KEY,
          value: JSON.stringify({
            version: 1,
            eventKey: input.key,
            command,
            acceptedAt: input.now.toISOString(),
          }),
          description: "Latest authenticated owner SMS control command",
        })
        .onDuplicateKeyUpdate({
          set: {
            value: JSON.stringify({
              version: 1,
              eventKey: input.key,
              command,
              acceptedAt: input.now.toISOString(),
            }),
            description: "Latest authenticated owner SMS control command",
          },
        });
      const reason = "Paused by verified owner via signed durable SMS";
      for (const entry of [
        { key: "kill_switch_active", value: "true" },
        { key: "system_status", value: "paused" },
        { key: "legacy_worker_owner_authorized", value: "false" },
      ]) {
        await tx
          .insert(systemConfig)
          .values({
            ...entry,
            description: reason,
          })
          .onDuplicateKeyUpdate({
            set: { value: entry.value, description: reason },
          });
      }
      await tx.insert(executionLog).values({
        actionType: "kill_switch_activated",
        details: {
          triggeredBy: "verified_owner",
          method: "signed_sms",
          inboxKey: input.key,
        },
        outcome: "success",
      });
    }
  });
}

/**
 * Persist an authenticated delivery before acknowledging Twilio. STOP also
 * commits the pause in the same transaction as the inbox insert.
 */
export async function enqueueInboundSms(
  payloadValue: InboundSmsPayload,
  payloadDigest: string,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<SmsInboxEnqueueResult> {
  const parsed = inboundSmsPayloadSchema.safeParse(payloadValue);
  const key = parsed.success ? eventKey(parsed.data.messageSid) : null;
  if (
    !parsed.success ||
    !key ||
    !/^[a-f0-9]{64}$/.test(payloadDigest) ||
    !Number.isFinite(now.getTime()) ||
    byteLength(parsed.data) > MAX_PAYLOAD_BYTES
  ) {
    return { disposition: "invalid" };
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const eventType = classifyEventType(parsed.data.message);
  try {
    if (eventType === "sms_stop" || eventType === "sms_start") {
      await insertControlCommand(db, {
        key,
        eventType,
        payloadDigest,
        payload: parsed.data,
        now,
      });
    } else {
      await db.insert(providerWebhookInbox).values({
        provider: PROVIDER,
        eventKey: key,
        eventType,
        externalId: parsed.data.messageSid,
        payloadDigest,
        payload: parsed.data,
        state: "pending",
        attemptCount: 0,
        receivedAt: now,
      });
    }
    return { disposition: "accepted", key, created: true };
  } catch (error) {
    if (!isMysqlDuplicateKeyError(error)) throw error;
  }

  const existing = await readInboxRow(key, db);
  if (!existing) throw new Error("SMS inbox row disappeared after conflict");
  if (existing.payloadDigest !== payloadDigest) {
    await db
      .update(providerWebhookInbox)
      .set({
        state: "terminal_failure",
        failedAt: now,
        lastError:
          "Authenticated Twilio MessageSid was replayed with a different payload",
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: null,
      })
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, key),
          eq(providerWebhookInbox.payloadDigest, existing.payloadDigest)
        )
      );
    return { disposition: "conflict", key };
  }
  if (existing.state === "completed") {
    return { disposition: "completed", key };
  }
  if (existing.state === "terminal_failure") {
    return { disposition: "terminal_failure", key };
  }
  return { disposition: "accepted", key, created: false };
}

/**
 * Safety/read-only commands may bypass paused normal work. Within each class,
 * provider receipt order is preserved. A live processing row remains the head
 * of its class and prevents a second worker from claiming later work.
 */
export async function nextInboundSmsInboxKey(
  databaseOverride?: InboxDatabase
): Promise<string | null> {
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const oldestInClass = async (eventTypes?: string[]) => {
    const rows = await db
      .select({ key: providerWebhookInbox.eventKey })
      .from(providerWebhookInbox)
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          inArray(providerWebhookInbox.state, ["pending", "processing"]),
          ...(eventTypes
            ? [inArray(providerWebhookInbox.eventType, eventTypes)]
            : [])
        )
      )
      .orderBy(
        asc(providerWebhookInbox.receivedAt),
        asc(providerWebhookInbox.id)
      )
      .limit(1);
    return rows[0]?.key || null;
  };
  return (
    (await oldestInClass(["sms_stop", "sms_start"])) ||
    (await oldestInClass(["sms_status", "sms_read_only"])) ||
    (await oldestInClass())
  );
}

export async function claimInboundSmsInbox(
  key: string,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  databaseOverride?: InboxDatabase
): Promise<SmsInboxClaimResult> {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 30_000 ||
    leaseMs > 10 * 60_000
  ) {
    return { disposition: "invalid" };
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const existing = await readInboxRow(key, db);
  if (!existing) return { disposition: "missing" };
  if (existing.state === "completed") return { disposition: "completed" };
  if (existing.state === "terminal_failure") {
    return { disposition: "terminal_failure" };
  }
  if (
    existing.state === "processing" &&
    existing.leaseUntil &&
    existing.leaseUntil.getTime() > now.getTime()
  ) {
    return { disposition: "processing" };
  }
  if (
    existing.nextAttemptAt &&
    existing.nextAttemptAt.getTime() > now.getTime()
  ) {
    return { disposition: "deferred" };
  }
  if (existing.attemptCount >= MAX_ATTEMPTS) {
    await db
      .update(providerWebhookInbox)
      .set({
        state: "terminal_failure",
        failedAt: now,
        lastError: "SMS processing lease expired at retry limit",
        leaseToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, key),
          inArray(providerWebhookInbox.state, ["pending", "processing"]),
          eq(providerWebhookInbox.attemptCount, existing.attemptCount)
        )
      );
    return { disposition: "terminal_failure" };
  }

  const token = randomUUID();
  const attemptCount = existing.attemptCount + 1;
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: "processing",
      leaseToken: token,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attemptCount,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, existing.state),
        eq(providerWebhookInbox.attemptCount, existing.attemptCount),
        ...(existing.leaseToken
          ? [eq(providerWebhookInbox.leaseToken, existing.leaseToken)]
          : [])
      )
    );
  if (affectedRows(result) !== 1) return { disposition: "processing" };
  // Re-read after the CAS. A stale worker may have staged a dispatch marker
  // between our first read and lease replacement; returning the pre-CAS
  // snapshot could otherwise cause a second outbound reply.
  const claimed = await readInboxRow(key, db);
  if (
    !claimed ||
    claimed.state !== "processing" ||
    claimed.leaseToken !== token ||
    claimed.attemptCount !== attemptCount
  ) {
    throw new Error("SMS inbox claim could not verify its post-CAS state");
  }
  const payload = inboundSmsPayloadSchema.parse(claimed.payload);
  const workProduct = claimed.workProduct
    ? smsWorkProductSchema.parse(claimed.workProduct)
    : undefined;
  return {
    disposition: "acquired",
    key,
    token,
    payload,
    ...(workProduct ? { workProduct } : {}),
    attemptCount,
  };
}

export async function stageInboundSmsWorkProduct(
  key: string,
  token: string,
  workProductValue: SmsWorkProduct,
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  const parsed = smsWorkProductSchema.safeParse(workProductValue);
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    !parsed.success ||
    byteLength(parsed.data) > MAX_WORK_PRODUCT_BYTES
  ) {
    return false;
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const result = await db
    .update(providerWebhookInbox)
    .set({ workProduct: parsed.data })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  return affectedRows(result) === 1;
}

export async function completeInboundSmsInbox(
  key: string,
  token: string,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: "completed",
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      completedAt: now,
      lastError: null,
    })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  return affectedRows(result) === 1;
}

/**
 * Commit an accepted Twilio response receipt without depending on the worker's
 * lease still being current. The pre-dispatch work product is the immutable
 * compare key, so a late worker may preserve its real provider receipt but
 * cannot overwrite different or already-conflicting work.
 */
export async function persistInboundSmsResponseReceipt(
  key: string,
  expectedStartedProduct: SmsWorkProduct,
  receiptValue: z.infer<typeof responseReceiptSchema>,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  const expected = smsWorkProductSchema.safeParse(expectedStartedProduct);
  const receipt = responseReceiptSchema.safeParse(receiptValue);
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !expected.success ||
    expected.data.responseState !== "started" ||
    !receipt.success ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  return db.transaction(async tx => {
    const rows = await tx
      .select()
      .from(providerWebhookInbox)
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, key)
        )
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return false;
    const stored = smsWorkProductSchema.safeParse(row.workProduct);
    if (!stored.success) return false;
    if (
      responseDispatchIdentity(stored.data) !==
      responseDispatchIdentity(expected.data)
    ) {
      return false;
    }
    if (
      stored.data.responseState === "accepted" &&
      stored.data.responseReceipt?.sid !== receipt.data.sid
    ) {
      return false;
    }
    if (
      !["started", "reconciliation_required", "accepted"].includes(
        stored.data.responseState
      )
    ) {
      return false;
    }

    const acceptedProduct = smsWorkProductSchema.parse({
      ...stored.data,
      responseState: "accepted",
      responseReceipt: receipt.data,
    });
    const result = await tx
      .update(providerWebhookInbox)
      .set({
        state: "completed",
        workProduct: acceptedProduct,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: null,
        completedAt: now,
        failedAt: null,
        lastError: null,
      })
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, key)
        )
      );
    return affectedRows(result) === 1;
  });
}

function responseDispatchIdentity(product: SmsWorkProduct): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: product.version,
        commandKind: product.commandKind,
        effectState: product.effectState,
        reply: product.reply ?? null,
        conversationPlan: product.conversationPlan ?? null,
        taskId: product.taskId ?? null,
        approvalFingerprint: product.approvalFingerprint ?? null,
        approvalRequestId: product.approvalRequestId ?? null,
      }),
      "utf8"
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    );
  }
  return value;
}

export async function deferInboundSmsInbox(
  key: string,
  token: string,
  reason: string,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const existing = await readInboxRow(key, db);
  if (
    !existing ||
    existing.state !== "processing" ||
    existing.leaseToken !== token ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: "pending",
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: new Date(now.getTime() + 15_000),
      attemptCount: Math.max(0, existing.attemptCount - 1),
      lastError: reason.slice(0, 500),
    })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  return affectedRows(result) === 1;
}

export async function releaseInboundSmsInboxForRetry(
  key: string,
  token: string,
  error: string,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<{ released: boolean; terminal: boolean }> {
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const existing = await readInboxRow(key, db);
  if (
    !existing ||
    existing.state !== "processing" ||
    existing.leaseToken !== token ||
    !Number.isFinite(now.getTime())
  ) {
    return { released: false, terminal: false };
  }
  const terminal = existing.attemptCount >= MAX_ATTEMPTS;
  const delayMs = Math.min(
    60_000,
    2_000 * 2 ** Math.max(0, existing.attemptCount - 1)
  );
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: terminal ? "terminal_failure" : "pending",
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: terminal ? null : new Date(now.getTime() + delayMs),
      failedAt: terminal ? now : null,
      lastError: error.slice(0, 500),
    })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  return { released: affectedRows(result) === 1, terminal };
}

export async function terminalizeInboundSmsInbox(
  key: string,
  token: string,
  error: string,
  workProductValue?: SmsWorkProduct,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  const parsed = workProductValue
    ? smsWorkProductSchema.safeParse(workProductValue)
    : null;
  if (parsed && !parsed.success) return false;
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: "terminal_failure",
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: null,
      failedAt: now,
      lastError: error.slice(0, 500),
      ...(parsed?.success ? { workProduct: parsed.data } : {}),
    })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  return affectedRows(result) === 1;
}

function initialWorkProduct(
  commandKind: SmsWorkProduct["commandKind"],
  extra?: Partial<SmsWorkProduct>
): SmsWorkProduct {
  return smsWorkProductSchema.parse({
    version: 1,
    commandKind,
    effectState: "pending",
    responseState: "none",
    ...extra,
  });
}

type LatestSmsControl = {
  version: 1;
  eventKey: string;
  command: "STOP" | "START";
  acceptedAt: string;
};

function parseLatestSmsControl(value: string): LatestSmsControl | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(String(parsed.eventKey || "")) ||
      (parsed.command !== "STOP" && parsed.command !== "START") ||
      !Number.isFinite(Date.parse(String(parsed.acceptedAt || "")))
    ) {
      return null;
    }
    return parsed as LatestSmsControl;
  } catch {
    return null;
  }
}

/**
 * Apply a signed control in the same transaction that verifies the inbox lease
 * and stages the result. STOP is the only SMS command allowed to change the
 * runtime gate. SMS START is intentionally advisory because provider delivery
 * order cannot prove that it is newer than a previously accepted STOP.
 */
export async function applySignedSmsControl(
  claim: {
    key: string;
    token: string;
    payload: InboundSmsPayload;
  },
  expectedProduct: SmsWorkProduct
): Promise<SmsWorkProduct> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async tx => {
    const inboxRows = await tx
      .select()
      .from(providerWebhookInbox)
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, claim.key)
        )
      )
      .limit(1)
      .for("update");
    const inbox = inboxRows[0];
    if (
      !inbox ||
      inbox.state !== "processing" ||
      inbox.leaseToken !== claim.token
    ) {
      throw new Error("SMS control lost its exact active lease");
    }
    const storedProduct = smsWorkProductSchema.parse(inbox.workProduct);
    if (
      storedProduct.commandKind !== expectedProduct.commandKind ||
      storedProduct.effectState !== "pending" ||
      (storedProduct.commandKind !== "start" &&
        storedProduct.commandKind !== "stop")
    ) {
      throw new Error("SMS control work product changed before application");
    }

    const controlRows = await tx
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, LATEST_SMS_CONTROL_KEY))
      .limit(1)
      .for("update");
    const command =
      storedProduct.commandKind === "start" ? "START" : "STOP";

    let reply: string;
    if (command === "START") {
      reply =
        "[Addison] SMS cannot resume the worker because text delivery can arrive out of order. Use the authenticated owner dashboard.";
    } else {
      const latest = parseLatestSmsControl(controlRows[0]?.value || "");
      if (!latest) {
        throw new Error("Latest signed SMS control fence is unavailable");
      }
      const isLatest =
        latest.eventKey === claim.key && latest.command === command;
      if (!isLatest) {
      reply = `[Addison] Earlier ${command} was superseded by a later signed control command.`;
      } else {
      // STOP was committed atomically with inbox persistence at ingress.
      reply =
        storedProduct.reply ||
          "[Addison] System paused. Resume only from the authenticated owner dashboard.";
      }
    }

    const appliedProduct = smsWorkProductSchema.parse({
      ...storedProduct,
      effectState: "applied",
      reply,
      responseState: "planned",
    });
    const staged = await tx
      .update(providerWebhookInbox)
      .set({ workProduct: appliedProduct })
      .where(
        and(
          eq(providerWebhookInbox.provider, PROVIDER),
          eq(providerWebhookInbox.eventKey, claim.key),
          eq(providerWebhookInbox.state, "processing"),
          eq(providerWebhookInbox.leaseToken, claim.token)
        )
      );
    if (affectedRows(staged) !== 1) {
      throw new Error("SMS control lost its transactional staging fence");
    }
    return appliedProduct;
  });
}

async function requireActiveRuntime(): Promise<void> {
  const gate = await getLegacyWorkerRuntimeGate();
  if (!gate.allowed) {
    throw new SmsProcessingDeferredError(gate.reason || "Worker is paused");
  }
}

async function buildWorkProduct(
  payload: InboundSmsPayload
): Promise<SmsWorkProduct> {
  const message = payload.message.trim();
  const upper = message.toUpperCase();
  if (upper === "STOP") {
    return initialWorkProduct("stop", {
      reply:
        "[Addison] System paused. Resume only from the authenticated owner dashboard.",
    });
  }
  if (upper === "START") return initialWorkProduct("start");
  if (upper === "STATUS") return initialWorkProduct("status");

  const approve =
    /^APPROVE\s+#?(\d+)(?:\s+([A-F0-9]{64})\s+([A-F0-9-]{36}))?$/i.exec(
      message
    );
  if (upper === "APPROVE" || upper.startsWith("APPROVE ")) {
    return initialWorkProduct("approve", {
      ...(approve ? { taskId: Number(approve[1]) } : {}),
      ...(approve?.[2]
        ? { approvalFingerprint: approve[2].toLowerCase() }
        : {}),
      ...(approve?.[3]
        ? { approvalRequestId: approve[3].toLowerCase() }
        : {}),
    });
  }
  const reject = /^REJECT\s+#?(\d+)$/i.exec(message);
  if (upper === "REJECT" || upper.startsWith("REJECT ")) {
    return initialWorkProduct("reject", {
      ...(reject ? { taskId: Number(reject[1]) } : {}),
    });
  }

  if (
    !["TASKS", "QUEUE", "DONE", "COMPLETED", "HELP", "?"].includes(upper)
  ) {
    await requireActiveRuntime();
  }
  return initialWorkProduct("conversation", {
    conversationPlan: await planConversationalSMS(message),
  });
}

async function approvalWasAlreadyApplied(
  product: SmsWorkProduct
): Promise<boolean> {
  if (!product.taskId) return false;
  return hasExactOwnerTaskStatusAudit({
    taskId: product.taskId,
    previousStatus: "awaiting_approval",
    nextStatus: "pending",
    ...(product.approvalFingerprint
      ? { approvalFingerprint: product.approvalFingerprint }
      : {}),
    ...(product.approvalRequestId
      ? { approvalRequestId: product.approvalRequestId }
      : {}),
  });
}

async function rejectionWasAlreadyApplied(
  taskId: number
): Promise<boolean> {
  return hasExactOwnerTaskStatusAudit({
    taskId,
    previousStatus: "awaiting_approval",
    nextStatus: "cancelled",
  });
}

async function applyWorkProduct(
  payload: InboundSmsPayload,
  product: SmsWorkProduct
): Promise<SmsWorkProduct> {
  if (product.effectState === "applied") {
    return {
      ...product,
      responseState: product.reply ? "planned" : product.responseState,
    };
  }

  let reply: string;
  if (
    product.commandKind === "stop" ||
    product.commandKind === "start"
  ) {
    throw new Error("SMS control must use its transactional control fence");
  } else if (product.commandKind === "status") {
    const status = (await getConfig("system_status")) || "unknown";
    const gate = await getLegacyWorkerRuntimeGate();
    reply = `[Addison] System: ${status} | Autonomous: ${
      gate.allowed ? "running" : "blocked"
    }`;
  } else if (product.commandKind === "approve") {
    await requireActiveRuntime();
    if (!product.taskId) {
      reply = "[Addison] Which task? Example: APPROVE 123";
    } else {
      const task = await getTaskById(product.taskId);
      if (!task) {
        reply = `[Addison] Task #${product.taskId} was not found.`;
      } else {
        const external = new Set([
          "outbound_call",
          "send_email",
          "send_sms",
        ]).has(task.actionType || "");
        if (
          external &&
          (!product.approvalFingerprint || !product.approvalRequestId)
        ) {
          reply = `[Addison] Task #${task.id} needs the complete exact approval command shown with its final content.`;
        } else {
          const result = await updateTaskByOwnerWithAudit(task.id, {
            status: "pending",
            expectedStatus: "awaiting_approval",
            ...(product.approvalFingerprint
              ? { approvalFingerprint: product.approvalFingerprint }
              : {}),
            ...(product.approvalRequestId
              ? { approvalRequestId: product.approvalRequestId }
              : {}),
            approvalSource: "verified_sms",
          });
          const applied =
            (result.outcome === "updated" && result.statusChanged) ||
            (await approvalWasAlreadyApplied(product));
          reply = applied
            ? `[Addison] Task #${task.id} approved.`
            : `[Addison] Task #${task.id} changed or its approval is stale; it remains protected.`;
        }
      }
    }
  } else if (product.commandKind === "reject") {
    await requireActiveRuntime();
    if (!product.taskId) {
      reply = "[Addison] Which task? Example: REJECT 123";
    } else {
      const task = await getTaskById(product.taskId);
      if (!task) {
        reply = `[Addison] Task #${product.taskId} was not found.`;
      } else {
        const result = await updateTaskByOwnerWithAudit(task.id, {
          status: "cancelled",
          expectedStatus: "awaiting_approval",
        });
        const applied =
          (result.outcome === "updated" && result.statusChanged) ||
          (await rejectionWasAlreadyApplied(task.id));
        reply = applied
          ? `[Addison] Task #${task.id} cancelled.`
          : `[Addison] Task #${task.id} is no longer waiting for rejection.`;
      }
    }
  } else if (product.commandKind === "conversation") {
    if (!product.conversationPlan) {
      throw new Error("Durable conversation plan is missing");
    }
    if (product.conversationPlan.tasks.length > 0) {
      await requireActiveRuntime();
    }
    reply = await applyConversationalSmsPlan(
      product.conversationPlan,
      payload.message,
      `twilio:${payload.messageSid}`
    );
  } else {
    reply =
      product.reply ||
      "[Addison] The command was recorded without a response.";
  }

  return smsWorkProductSchema.parse({
    ...product,
    effectState: "applied",
    reply,
    responseState: "planned",
  });
}

type AcquiredClaim = Extract<
  SmsInboxClaimResult,
  { disposition: "acquired" }
>;

export async function processInboundSmsClaim(
  claim: AcquiredClaim
): Promise<void> {
  let product = claim.workProduct;
  let responseDispatchStarted = product?.responseState === "started";
  let acceptedResponseReceipt:
    | z.infer<typeof responseReceiptSchema>
    | undefined;
  try {
    if (product?.responseState === "accepted") {
      const completed = await completeInboundSmsInbox(claim.key, claim.token);
      if (!completed) {
        throw new Error("SMS inbox lost its post-receipt completion fence");
      }
      return;
    }
    if (
      product?.responseState === "started" ||
      product?.responseState === "reconciliation_required"
    ) {
      const reconciliationProduct = smsWorkProductSchema.parse({
        ...product,
        responseState: "reconciliation_required",
      });
      await terminalizeInboundSmsInbox(
        claim.key,
        claim.token,
        "Outbound SMS response began without a durable provider receipt; automatic resend is blocked",
        reconciliationProduct
      );
      return;
    }

    if (!product) {
      product = await buildWorkProduct(claim.payload);
      const staged = await stageInboundSmsWorkProduct(
        claim.key,
        claim.token,
        product
      );
      if (!staged) throw new Error("SMS plan lost its durable processing fence");
    }

    const controlAppliedTransactionally =
      product.effectState === "pending" &&
      (product.commandKind === "stop" || product.commandKind === "start");
    product = controlAppliedTransactionally
      ? await applySignedSmsControl(claim, product)
      : await applyWorkProduct(claim.payload, product);
    if (
      !controlAppliedTransactionally &&
      !(await stageInboundSmsWorkProduct(claim.key, claim.token, product))
    ) {
      throw new Error("SMS effect lost its durable processing fence");
    }

    await logExecutionOnce(`twilio:${claim.payload.messageSid}:processed`, {
      actionType: "inbound_sms",
      details: {
        authenticatedOwner: true,
        command: product.commandKind,
        messageLength: claim.payload.message.length,
        inboxKey: claim.key,
      },
      outcome: "success",
    });

    if (!product.reply) {
      if (!(await completeInboundSmsInbox(claim.key, claim.token))) {
        throw new Error("SMS inbox lost its durable completion fence");
      }
      return;
    }
    const reply = product.reply;

    product = smsWorkProductSchema.parse({
      ...product,
      responseState: "started",
    });
    if (
      !(await stageInboundSmsWorkProduct(claim.key, claim.token, product))
    ) {
      throw new Error("SMS response lost its pre-dispatch fence");
    }
    responseDispatchStarted = true;
    const receipt = await sendSMS(claim.payload.from, reply);
    if (!/^SM[a-fA-F0-9]{32}$/.test(receipt.sid)) {
      throw new Error(
        `SMS response was not accepted with a durable provider receipt (${receipt.status})`
      );
    }
    acceptedResponseReceipt = receipt;
    product = smsWorkProductSchema.parse({
      ...product,
      responseState: "accepted",
      responseReceipt: receipt,
    });
    const receiptPersisted = await persistInboundSmsResponseReceipt(
      claim.key,
      smsWorkProductSchema.parse({
        ...product,
        responseState: "started",
        responseReceipt: undefined,
      }),
      receipt
    );
    if (!receiptPersisted) {
      throw new Error(
        "SMS response receipt did not match the durable dispatch record"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SmsProcessingDeferredError) {
      await deferInboundSmsInbox(claim.key, claim.token, message);
      return;
    }
    if (responseDispatchStarted) {
      if (acceptedResponseReceipt && product) {
        const receiptPersisted = await persistInboundSmsResponseReceipt(
          claim.key,
          smsWorkProductSchema.parse({
            ...product,
            responseState: "started",
            responseReceipt: undefined,
          }),
          acceptedResponseReceipt
        ).catch(() => false);
        if (receiptPersisted) return;
      }
      const reconciliationProduct = product
        ? smsWorkProductSchema.parse({
            ...product,
            responseState: acceptedResponseReceipt
              ? "accepted"
              : "reconciliation_required",
            responseReceipt: acceptedResponseReceipt,
          })
        : undefined;
      await terminalizeInboundSmsInbox(
        claim.key,
        claim.token,
        message,
        reconciliationProduct
      );
      await logExecutionOnce(`twilio:${claim.key}:response-reconciliation`, {
        actionType: "sms_response_reconciliation_required",
        details: {
          inboxKey: claim.key,
          messageSid: claim.payload.messageSid,
          automaticResendBlocked: true,
        },
        outcome: "partial",
        errorMessage: message.slice(0, 500),
      }).catch(() => false);
      return;
    }
    const released = await releaseInboundSmsInboxForRetry(
      claim.key,
      claim.token,
      message
    );
    if (released.terminal) {
      await logExecutionOnce(`twilio:${claim.key}:terminal-failure`, {
        actionType: "sms_webhook_terminal_failure",
        details: {
          inboxKey: claim.key,
          messageSid: claim.payload.messageSid,
          attemptCount: claim.attemptCount,
        },
        outcome: "failure",
        errorMessage: message.slice(0, 500),
      }).catch(() => false);
    }
  }
}

export async function drainInboundSmsInbox(maxMessages = 10): Promise<number> {
  if (isPrivateCandidateInternalOnly() || !ownerSmsChannelCertified()) return 0;
  const bounded = Math.max(1, Math.min(maxMessages, 25));
  let processed = 0;
  for (let index = 0; index < bounded; index += 1) {
    const key = await nextInboundSmsInboxKey();
    if (!key) break;
    const claim = await claimInboundSmsInbox(key);
    if (claim.disposition !== "acquired") break;
    await processInboundSmsClaim(claim);
    processed += 1;
  }
  return processed;
}

export function startInboundSmsInboxWorker(): () => void {
  const run = () => {
    void drainInboundSmsInbox().catch(error => {
      console.error(
        "[SMS Webhook] Inbox worker failed:",
        error instanceof Error ? error.message : "unknown error"
      );
    });
  };
  run();
  const timer = setInterval(run, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

export { EMPTY_TWIML };
