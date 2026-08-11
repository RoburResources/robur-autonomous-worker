import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, lte } from "drizzle-orm";
import { providerWebhookInbox } from "../../drizzle/schema";
import { getDb, isMysqlDuplicateKeyError } from "../db";

const PROVIDER = "retell";
const MAX_PAYLOAD_BYTES = 256_000;
const MAX_WORK_PRODUCT_BYTES = 64_000;
const MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 2 * 60_000;

type JsonObject = Record<string, unknown>;
type InboxDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "insert" | "select" | "update"
>;

export type RetellInboxEnqueueResult =
  | { disposition: "accepted"; key: string; created: boolean }
  | { disposition: "completed"; key: string }
  | { disposition: "conflict"; key: string }
  | { disposition: "invalid" };

export type RetellInboxClaimResult =
  | {
      disposition: "acquired";
      key: string;
      token: string;
      eventType: string;
      callId: string;
      payload: JsonObject;
      workProduct?: JsonObject;
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

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validEventIdentity(eventType: string, callId: string): boolean {
  return (
    /^[a-z][a-z0-9_]{0,63}$/.test(eventType) &&
    /^[A-Za-z0-9_-]{8,160}$/.test(callId)
  );
}

function eventKey(eventType: string, callId: string): string | null {
  if (!validEventIdentity(eventType, callId)) return null;
  return createHash("sha256")
    .update(`${eventType}\0${callId}`, "utf8")
    .digest("hex");
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

export async function enqueueRetellWebhook(
  eventType: string,
  callId: string,
  payloadDigest: string,
  payload: JsonObject,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<RetellInboxEnqueueResult> {
  const key = eventKey(eventType, callId);
  if (
    !key ||
    !/^[a-f0-9]{64}$/.test(payloadDigest) ||
    !Number.isFinite(now.getTime()) ||
    !isJsonObject(payload) ||
    byteLength(payload) > MAX_PAYLOAD_BYTES
  ) {
    return { disposition: "invalid" };
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  try {
    await db.insert(providerWebhookInbox).values({
      provider: PROVIDER,
      eventKey: key,
      eventType,
      externalId: callId,
      payloadDigest,
      payload,
      state: "pending",
      attemptCount: 0,
      receivedAt: now,
    });
    return { disposition: "accepted", key, created: true };
  } catch (error) {
    if (!isMysqlDuplicateKeyError(error)) throw error;
  }

  const existing = await readInboxRow(key, db);
  if (!existing) throw new Error("Retell inbox row disappeared after conflict");
  if (existing.payloadDigest !== payloadDigest) {
    await db
      .update(providerWebhookInbox)
      .set({
        state: "terminal_failure",
        failedAt: now,
        lastError:
          "Authenticated Retell event identity was replayed with a different payload",
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
  return { disposition: "accepted", key, created: false };
}

export async function listRetellWebhookInboxKeys(
  limit = 25,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<string[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(now.getTime())
  ) {
    return [];
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const rows = await db
    .select({ key: providerWebhookInbox.eventKey })
    .from(providerWebhookInbox)
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        inArray(providerWebhookInbox.state, ["pending", "processing"]),
        or(
          and(
            eq(providerWebhookInbox.state, "pending"),
            or(
              isNull(providerWebhookInbox.nextAttemptAt),
              lte(providerWebhookInbox.nextAttemptAt, now)
            )
          ),
          and(
            eq(providerWebhookInbox.state, "processing"),
            or(
              isNull(providerWebhookInbox.leaseUntil),
              lte(providerWebhookInbox.leaseUntil, now)
            )
          )
        )
      )
    )
    .orderBy(
      asc(providerWebhookInbox.nextAttemptAt),
      asc(providerWebhookInbox.receivedAt)
    )
    .limit(limit);
  return rows.map(row => row.key);
}

export async function claimRetellWebhook(
  key: string,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  databaseOverride?: InboxDatabase
): Promise<RetellInboxClaimResult> {
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
        lastError: "Retell webhook processing lease expired at retry limit",
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
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: "processing",
      leaseToken: token,
      leaseUntil,
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
  const driverResult = (result as any)?.[0] ?? result;
  if (
    Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) !== 1
  ) {
    return { disposition: "processing" };
  }
  // Re-read after the CAS. The previous worker may have staged a work product
  // between our first read and lease takeover, so only the row owned by this
  // token is authoritative for subsequent processing.
  const claimed = await readInboxRow(key, db);
  if (
    !claimed ||
    claimed.state !== "processing" ||
    claimed.leaseToken !== token ||
    claimed.attemptCount !== attemptCount
  ) {
    throw new Error("Retell inbox claim could not verify its post-CAS state");
  }
  if (!isJsonObject(claimed.payload)) {
    throw new Error("Stored Retell inbox payload is invalid");
  }
  return {
    disposition: "acquired",
    key,
    token,
    eventType: claimed.eventType,
    callId: claimed.externalId,
    payload: claimed.payload,
    ...(isJsonObject(claimed.workProduct)
      ? { workProduct: claimed.workProduct }
      : {}),
    attemptCount,
  };
}

export async function stageRetellWebhookWorkProduct(
  key: string,
  token: string,
  workProduct: JsonObject,
  databaseOverride?: InboxDatabase
): Promise<boolean> {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    !isJsonObject(workProduct) ||
    byteLength(workProduct) > MAX_WORK_PRODUCT_BYTES
  ) {
    return false;
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const result = await db
    .update(providerWebhookInbox)
    .set({ workProduct })
    .where(
      and(
        eq(providerWebhookInbox.provider, PROVIDER),
        eq(providerWebhookInbox.eventKey, key),
        eq(providerWebhookInbox.state, "processing"),
        eq(providerWebhookInbox.leaseToken, token)
      )
    );
  const driverResult = (result as any)?.[0] ?? result;
  return (
    Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1
  );
}

export async function completeRetellWebhook(
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
  const driverResult = (result as any)?.[0] ?? result;
  return (
    Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1
  );
}

export async function releaseRetellWebhookForRetry(
  key: string,
  token: string,
  error: string,
  now = new Date(),
  databaseOverride?: InboxDatabase
): Promise<{ released: boolean; terminal: boolean }> {
  if (
    !/^[a-f0-9]{64}$/.test(key) ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    !Number.isFinite(now.getTime())
  ) {
    return { released: false, terminal: false };
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const existing = await readInboxRow(key, db);
  if (
    !existing ||
    existing.state !== "processing" ||
    existing.leaseToken !== token
  ) {
    return { released: false, terminal: false };
  }
  const terminal = existing.attemptCount >= MAX_ATTEMPTS;
  const retryDelayMs = Math.min(
    60_000,
    2_000 * 2 ** Math.max(0, existing.attemptCount - 1)
  );
  const result = await db
    .update(providerWebhookInbox)
    .set({
      state: terminal ? "terminal_failure" : "pending",
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: terminal
        ? null
        : new Date(now.getTime() + retryDelayMs),
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
  const driverResult = (result as any)?.[0] ?? result;
  return {
    released:
      Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) ===
      1,
    terminal,
  };
}
