import {
  eq,
  desc,
  asc,
  and,
  sql,
  gte,
  lte,
  like,
  isNotNull,
  inArray,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash, randomUUID } from "node:crypto";
import {
  InsertUser, users,
  goals, InsertGoal, Goal,
  taskQueue, InsertTask, Task,
  executionLog, InsertExecutionLogEntry,
  evaluations, InsertEvaluation,
  opportunities, InsertOpportunity,
  systemConfig, InsertSystemConfigEntry,
  dailyMetrics, DailyMetric, InsertDailyMetric,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import {
  externalApprovalArtifact,
  externalTaskApprovalFingerprint,
} from "./safety/externalTaskApproval";
import { normalizeTaskMetadata } from "./autonomous/taskMetadata";

let _db: ReturnType<typeof drizzle> | null = null;

export function isMysqlDuplicateKeyError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      code?: string;
      errno?: number;
      cause?: unknown;
    };
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── User Helpers ───────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = 'admin'; updateSet.role = 'admin'; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot get user: database not available"); return undefined; }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Goals Helpers ──────────────────────────────────────────────────────────

export async function getActiveGoals() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(goals).where(eq(goals.status, "active")).orderBy(desc(goals.priority));
}

export async function getAllGoals() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(goals).orderBy(desc(goals.priority));
}

export async function createGoal(goal: InsertGoal) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(goals).values(goal);
  return result;
}

export async function updateGoal(id: number, data: Partial<InsertGoal>) {
  const db = await getDb();
  if (!db) return;
  await db.update(goals).set(data).where(eq(goals.id, id));
}

// ─── Task Queue Helpers ─────────────────────────────────────────────────────

export async function getTasksByStatus(status: Task["status"], limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskQueue).where(eq(taskQueue.status, status)).orderBy(desc(taskQueue.priorityScore)).limit(limit);
}

export async function getHighestPriorityPendingTask() {
  const db = await getDb();
  if (!db) return null;
  const results = await db.select().from(taskQueue).where(eq(taskQueue.status, "pending")).orderBy(desc(taskQueue.priorityScore)).limit(1);
  return results[0] || null;
}

export async function getTaskById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const results = await db.select().from(taskQueue).where(eq(taskQueue.id, id)).limit(1);
  return results[0] || null;
}

export async function createTask(task: InsertTask) {
  const db = await getDb();
  if (!db) return null;
  return db.insert(taskQueue).values(task);
}

type CreateTaskOnceDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "transaction"
>;

export async function createTaskOnce(
  idempotencyKey: string,
  task: InsertTask,
  databaseOverride?: CreateTaskOnceDatabase
): Promise<{ created: boolean; taskId?: number }> {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey || normalizedKey.length > 1_024) {
    throw new Error("Task idempotency key is invalid");
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const digest = createHash("sha256")
    .update(normalizedKey, "utf8")
    .digest("hex");

  return db.transaction(async tx => {
    try {
      await tx.insert(systemConfig).values({
        key: `task_once_${digest}`,
        value: new Date().toISOString(),
        description: "Atomic task-creation idempotency claim",
      });
    } catch (error) {
      if (isMysqlDuplicateKeyError(error)) {
        return { created: false };
      }
      throw error;
    }
    const inserted = await tx.insert(taskQueue).values(task);
    const driverResult = (inserted as any)?.[0] ?? inserted;
    const taskId = Number(driverResult?.insertId);
    return {
      created: true,
      ...(Number.isSafeInteger(taskId) && taskId > 0 ? { taskId } : {}),
    };
  });
}

export function withTaskStatusTimestamp(
  data: Partial<InsertTask>,
  now = new Date()
): Partial<InsertTask> {
  if (!data.status) return data;
  return {
    ...data,
    completedAt:
      data.status === "completed" || data.status === "failed"
        ? data.completedAt ?? now
        : null,
  };
}

export async function updateTask(id: number, data: Partial<InsertTask>) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(taskQueue)
    .set(withTaskStatusTimestamp(data))
    .where(eq(taskQueue.id, id));
}

export type OwnerTaskUpdateResult =
  | { outcome: "not_found" }
  | {
      outcome: "state_conflict";
      previousStatus: Task["status"];
      expectedStatus: Task["status"];
      nextStatus: Task["status"];
    }
  | {
      outcome: "approval_stale";
      previousStatus: Task["status"];
      nextStatus: Task["status"];
    }
  | {
      outcome: "updated";
      previousStatus: Task["status"];
      nextStatus: Task["status"];
      statusChanged: boolean;
    };

type OwnerTaskUpdateDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "transaction"
>;

export type ExternalOutcomeResolution =
  | "confirmed_completed"
  | "confirmed_not_performed"
  | "cancelled_unknown";

export type ExternalOutcomeReconciliationResult =
  | { outcome: "not_found" }
  | { outcome: "state_conflict" }
  | {
      outcome: "reconciled";
      nextStatus: Task["status"];
      freshApprovalRequired: boolean;
      approvalFingerprint?: string;
      approvalRequestId?: string;
    };

const APPROVAL_REQUEST_ACTION_TYPES = [
  "external_contact_approval_request",
  "approval_request",
  "confidence_gate_escalation",
  "canary_modification_required",
  "task_execution_external_outcome_reconciliation_required",
] as const;

const APPROVAL_BOUNDARY_ACTION_TYPES = [
  ...APPROVAL_REQUEST_ACTION_TYPES,
  "task_execution",
] as const;

const EXTERNAL_EFFECT_ACTION_TYPES = new Set([
  "outbound_call",
  "send_email",
  "send_sms",
]);
const APPROVAL_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function updateTaskByOwnerWithAudit(
  id: number,
  data: Partial<Pick<InsertTask, "status" | "priorityScore">> & {
    expectedStatus?: Task["status"];
    approvalFingerprint?: string;
    approvalRequestId?: string;
    approvalSource?: "owner_dashboard" | "verified_sms";
  },
  databaseOverride?: OwnerTaskUpdateDatabase
): Promise<OwnerTaskUpdateResult> {
  const db = databaseOverride ?? await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }

  return db.transaction(async tx => {
    const existing = await tx
      .select()
      .from(taskQueue)
      .where(eq(taskQueue.id, id))
      .limit(1)
      .for("update");
    const task = existing[0];
    if (!task) {
      return { outcome: "not_found" };
    }

    const nextStatus = data.status ?? task.status;
    const statusChanged = nextStatus !== task.status;
    if (
      statusChanged &&
      (data.expectedStatus === undefined ||
        data.expectedStatus !== task.status)
    ) {
      return {
        outcome: "state_conflict",
        previousStatus: task.status,
        expectedStatus: data.expectedStatus ?? task.status,
        nextStatus,
      };
    }
    const isExternalEffectTask = EXTERNAL_EFFECT_ACTION_TYPES.has(
      task.actionType || ""
    );
    const taskMetadata = normalizeTaskMetadata(task.metadata);
    if (
      statusChanged &&
      taskMetadata.external_outcome_reconciliation_required === true
    ) {
      return {
        outcome: "approval_stale",
        previousStatus: task.status,
        nextStatus,
      };
    }
    if (
      statusChanged &&
      isExternalEffectTask &&
      (nextStatus === "awaiting_approval" || task.status === "in_progress")
    ) {
      return {
        outcome: "approval_stale",
        previousStatus: task.status,
        nextStatus,
      };
    }
    let approvalFingerprint: string | undefined;
    let validatedApprovalRequestId: string | undefined;
    if (task.status === "awaiting_approval" && nextStatus === "pending") {
      const approvalBoundary = await tx
        .select({
          actionType: executionLog.actionType,
          details: executionLog.details,
        })
        .from(executionLog)
        .where(
          and(
            eq(executionLog.taskId, id),
            inArray(
              executionLog.actionType,
              APPROVAL_BOUNDARY_ACTION_TYPES as unknown as string[]
            )
          )
        )
        .orderBy(desc(executionLog.createdAt), desc(executionLog.id))
        .limit(1);
      const latestBoundary = approvalBoundary[0];
      const boundaryDetails = normalizeTaskMetadata(latestBoundary?.details);
      const currentFingerprint = externalTaskApprovalFingerprint(task);
      const currentApprovalRequestId =
        typeof taskMetadata.external_approval_request_id === "string" &&
        APPROVAL_REQUEST_ID_PATTERN.test(
          taskMetadata.external_approval_request_id
        )
          ? taskMetadata.external_approval_request_id
          : undefined;
      const suppliedFingerprintMatches =
        isExternalEffectTask
          ? data.approvalFingerprint === currentFingerprint
          : data.approvalFingerprint === undefined ||
            data.approvalFingerprint === currentFingerprint;
      const suppliedRequestMatches =
        currentApprovalRequestId === undefined ||
        (boundaryDetails.approvalRequestId === currentApprovalRequestId &&
          data.approvalRequestId === currentApprovalRequestId);
      const exactArtifactWasPresented =
        suppliedFingerprintMatches &&
        suppliedRequestMatches &&
        boundaryDetails.approvalRequestId === currentApprovalRequestId &&
        ((data.approvalSource === "verified_sms" &&
          boundaryDetails.presentationMode === "sms_full" &&
          boundaryDetails.notificationSent === true) ||
          (data.approvalSource === "owner_dashboard" &&
            data.approvalFingerprint === currentFingerprint));
      if (
        !latestBoundary ||
        !APPROVAL_REQUEST_ACTION_TYPES.includes(
          latestBoundary.actionType as (typeof APPROVAL_REQUEST_ACTION_TYPES)[number]
        ) ||
        boundaryDetails.approvalFingerprint !== currentFingerprint ||
        !suppliedRequestMatches ||
        taskMetadata.external_outcome_reconciliation_required === true ||
        (isExternalEffectTask &&
          (!externalApprovalArtifact(task) ||
            !exactArtifactWasPresented ||
            latestBoundary.actionType ===
              "task_execution_external_outcome_reconciliation_required"))
      ) {
        return {
          outcome: "approval_stale",
          previousStatus: task.status,
          nextStatus,
        };
      }
      approvalFingerprint = currentFingerprint;
      validatedApprovalRequestId = currentApprovalRequestId;
    }
    if (
      statusChanged &&
      nextStatus === "pending" &&
      EXTERNAL_EFFECT_ACTION_TYPES.has(task.actionType || "") &&
      task.status !== "awaiting_approval"
    ) {
      return {
        outcome: "approval_stale",
        previousStatus: task.status,
        nextStatus,
      };
    }
    const updateData: Partial<InsertTask> = {};
    if (
      data.priorityScore !== undefined &&
      data.priorityScore !== task.priorityScore
    ) {
      updateData.priorityScore = data.priorityScore;
    }
    if (statusChanged) {
      Object.assign(
        updateData,
        withTaskStatusTimestamp({ status: nextStatus })
      );
    }
    if (Object.keys(updateData).length > 0) {
      await tx
        .update(taskQueue)
        .set(updateData)
        .where(eq(taskQueue.id, id));
    }

    if (statusChanged) {
      await tx.insert(executionLog).values({
        taskId: id,
        actionType: "owner_task_status_update",
        details: {
          previousStatus: task.status,
          nextStatus,
          actor: "verified_owner",
          ...(approvalFingerprint ? { approvalFingerprint } : {}),
          ...(validatedApprovalRequestId
            ? { approvalRequestId: validatedApprovalRequestId }
            : {}),
        },
        outcome: nextStatus === "failed" ? "failure" : "success",
      });
    }

    return {
      outcome: "updated",
      previousStatus: task.status,
      nextStatus,
      statusChanged,
    };
  });
}

export async function reconcileExternalOutcomeByOwner(
  id: number,
  input: {
    resolution: ExternalOutcomeResolution;
    evidence: string;
    expectedReconciliationId: string;
  },
  databaseOverride?: OwnerTaskUpdateDatabase
): Promise<ExternalOutcomeReconciliationResult> {
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const evidence = input.evidence.trim();
  if (evidence.length < 10 || evidence.length > 2_000) {
    throw new Error("Reconciliation evidence must be 10 to 2,000 characters");
  }
  if (
    /(?:\bsk-[a-z0-9_-]{20,}|\bbearer\s+\S{20,}|api[_ -]?key\s*[:=]\s*\S{12,})/i.test(
      evidence
    )
  ) {
    throw new Error(
      "Reconciliation evidence must not contain credentials or API keys"
    );
  }

  return db.transaction(async tx => {
    const existing = await tx
      .select()
      .from(taskQueue)
      .where(eq(taskQueue.id, id))
      .limit(1)
      .for("update");
    const task = existing[0];
    if (!task) return { outcome: "not_found" };

    const metadata = normalizeTaskMetadata(task.metadata);
    if (
      task.status !== "awaiting_approval" ||
      !EXTERNAL_EFFECT_ACTION_TYPES.has(task.actionType || "") ||
      metadata.external_outcome_reconciliation_required !== true ||
      metadata.external_outcome_reconciliation_id !==
        input.expectedReconciliationId
    ) {
      return { outcome: "state_conflict" };
    }

    const {
      external_outcome_reconciliation_required: _required,
      external_outcome_reconciliation_at: _at,
      external_outcome_reconciliation_id: _id,
      execution_claim_token: _claimToken,
      execution_claimed_at: _claimedAt,
      external_dispatch_id: _dispatchId,
      external_dispatch_provider: _dispatchProvider,
      external_dispatch_started_at: _dispatchStartedAt,
      external_dispatch_artifact_fingerprint: _dispatchFingerprint,
      external_dispatch_approval_request_id: _dispatchApprovalRequestId,
      external_provider_receipt: _providerReceipt,
      external_provider_accepted: _providerAccepted,
      ...preservedMetadata
    } = metadata;
    const reconciledAt = new Date().toISOString();
    const resolutionRecord = {
      resolution: input.resolution,
      evidence,
      reconciledAt,
      actor: "verified_owner",
      providerReceipt:
        metadata.external_provider_receipt &&
        typeof metadata.external_provider_receipt === "object"
          ? metadata.external_provider_receipt
          : undefined,
      dispatch:
        typeof metadata.external_dispatch_id === "string"
          ? {
              id: metadata.external_dispatch_id,
              provider: metadata.external_dispatch_provider,
              startedAt: metadata.external_dispatch_started_at,
              artifactFingerprint:
                metadata.external_dispatch_artifact_fingerprint,
              approvalRequestId:
                metadata.external_dispatch_approval_request_id,
            }
          : undefined,
    };
    const nextStatus: Task["status"] =
      input.resolution === "confirmed_completed"
        ? "completed"
        : input.resolution === "cancelled_unknown"
          ? "cancelled"
          : "awaiting_approval";
    const freshApprovalRequired =
      input.resolution === "confirmed_not_performed";
    const approvalFingerprint = freshApprovalRequired
      ? externalTaskApprovalFingerprint(task)
      : undefined;
    const approvalRequestId = freshApprovalRequired ? randomUUID() : undefined;
    if (freshApprovalRequired && !externalApprovalArtifact(task)) {
      return { outcome: "state_conflict" };
    }

    const updateResult = await tx
      .update(taskQueue)
      .set(
        withTaskStatusTimestamp({
          status: nextStatus,
          completedAt:
            nextStatus === "completed" ? new Date(reconciledAt) : null,
          resultSummary:
            input.resolution === "confirmed_completed"
              ? "Owner reconciliation confirmed the provider completed this external action."
              : input.resolution === "confirmed_not_performed"
                ? "Owner reconciliation confirmed no external action occurred. A fresh exact-artifact approval is required before any retry."
                : "Owner cancelled this task without retry because the provider outcome remains unknown.",
          metadata: {
            ...preservedMetadata,
            external_outcome_reconciliation: resolutionRecord,
            ...(approvalRequestId
              ? { external_approval_request_id: approvalRequestId }
              : {}),
          },
        })
      )
      .where(
        and(
          eq(taskQueue.id, id),
          eq(taskQueue.status, "awaiting_approval")
        )
      );
    const updateDriverResult = (updateResult as any)?.[0] ?? updateResult;
    if (
      Number(
        updateDriverResult?.affectedRows ??
          updateDriverResult?.rowsAffected ??
          0
      ) !== 1
    ) {
      return { outcome: "state_conflict" };
    }

    await tx.insert(executionLog).values({
      taskId: id,
      actionType: "owner_external_outcome_reconciliation",
      details: resolutionRecord,
      outcome:
        input.resolution === "cancelled_unknown" ? "partial" : "success",
    });

    if (freshApprovalRequired && approvalFingerprint) {
      await tx.insert(executionLog).values({
        taskId: id,
        actionType: "external_contact_approval_request",
        details: {
          approvalFingerprint,
          approvalRequestId,
          presentationMode: "dashboard_full",
          notificationSent: false,
          freshApprovalAfterReconciliation: true,
        },
        outcome: "success",
      });
    }

    return {
      outcome: "reconciled",
      nextStatus,
      freshApprovalRequired,
      ...(approvalFingerprint ? { approvalFingerprint } : {}),
      ...(approvalRequestId ? { approvalRequestId } : {}),
    };
  });
}

export async function claimPendingTask(
  id: number,
  executionToken: string,
  expectedApprovalFingerprint?: string,
  expectedApprovalRequestId?: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  if (!executionToken) return false;
  const result = await db
    .update(taskQueue)
    .set({
      status: "in_progress",
      metadata: sql`JSON_SET(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.execution_claim_token', ${executionToken}, '$.execution_claimed_at', ${new Date().toISOString()})`,
    })
    .where(
      and(
        eq(taskQueue.id, id),
        eq(taskQueue.status, "pending"),
        ...(expectedApprovalFingerprint
          ? [
              sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_approval_fingerprint')) = ${expectedApprovalFingerprint}`,
            ]
          : []),
        ...(expectedApprovalRequestId
          ? [
              sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_approval_request_id')) = ${expectedApprovalRequestId}`,
            ]
          : [])
      )
    );
  const driverResult = (result as any)?.[0] ?? result;
  return Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1;
}

export type ExternalDispatchMarker = {
  dispatchId: string;
  provider: "retell" | "sendgrid" | "twilio";
  startedAt: string;
};

export type ClaimedExternalProviderReceipt = {
  provider: ExternalDispatchMarker["provider"];
  receiptId: string;
  acceptedAt: string;
  artifactFingerprint: string;
  approvalRequestId: string;
};

type ClaimedExternalDispatchDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "update"
>;

export async function beginClaimedExternalDispatch(
  id: number,
  executionToken: string,
  approvalFingerprint: string,
  approvalRequestId: string,
  provider: ExternalDispatchMarker["provider"],
  databaseOverride?: ClaimedExternalDispatchDatabase
): Promise<ExternalDispatchMarker | null> {
  const db = databaseOverride ?? (await getDb());
  if (
    !db ||
    !executionToken ||
    !/^[a-f0-9]{64}$/.test(approvalFingerprint) ||
    !APPROVAL_REQUEST_ID_PATTERN.test(approvalRequestId)
  ) {
    return null;
  }
  const dispatchId = randomUUID();
  const startedAt = new Date().toISOString();
  const result = await db
    .update(taskQueue)
    .set({
      metadata: sql`JSON_SET(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.external_dispatch_id', ${dispatchId}, '$.external_dispatch_provider', ${provider}, '$.external_dispatch_started_at', ${startedAt}, '$.external_dispatch_artifact_fingerprint', ${approvalFingerprint}, '$.external_dispatch_approval_request_id', ${approvalRequestId})`,
    })
    .where(
      and(
        eq(taskQueue.id, id),
        eq(taskQueue.status, "in_progress"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.execution_claim_token')) = ${executionToken}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_approval_fingerprint')) = ${approvalFingerprint}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_approval_request_id')) = ${approvalRequestId}`,
        sql`JSON_EXTRACT(${taskQueue.metadata}, '$.external_dispatch_id') IS NULL`,
        sql`JSON_EXTRACT(${taskQueue.metadata}, '$.external_provider_receipt') IS NULL`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_outcome_reconciliation_required')), 'false') <> 'true'`
      )
    );
  const driverResult = (result as any)?.[0] ?? result;
  return Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) ===
    1
    ? { dispatchId, provider, startedAt }
    : null;
}

export async function persistClaimedExternalProviderReceipt(
  id: number,
  executionToken: string,
  dispatchId: string,
  receipt: ClaimedExternalProviderReceipt,
  databaseOverride?: ClaimedExternalDispatchDatabase
): Promise<boolean> {
  const db = databaseOverride ?? (await getDb());
  if (
    !db ||
    !executionToken ||
    !APPROVAL_REQUEST_ID_PATTERN.test(dispatchId) ||
    !receipt.receiptId ||
    receipt.receiptId.length > 500 ||
    !/^[a-f0-9]{64}$/.test(receipt.artifactFingerprint) ||
    !APPROVAL_REQUEST_ID_PATTERN.test(receipt.approvalRequestId)
  ) {
    return false;
  }
  const serializedReceipt = JSON.stringify(receipt);
  const result = await db
    .update(taskQueue)
    .set({
      metadata: sql`JSON_SET(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.external_provider_receipt', CAST(${serializedReceipt} AS JSON))`,
    })
    .where(
      and(
        eq(taskQueue.id, id),
        eq(taskQueue.status, "in_progress"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.execution_claim_token')) = ${executionToken}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_dispatch_id')) = ${dispatchId}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_dispatch_provider')) = ${receipt.provider}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_dispatch_artifact_fingerprint')) = ${receipt.artifactFingerprint}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_dispatch_approval_request_id')) = ${receipt.approvalRequestId}`,
        sql`JSON_EXTRACT(${taskQueue.metadata}, '$.external_provider_receipt') IS NULL`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.external_outcome_reconciliation_required')), 'false') <> 'true'`
      )
    );
  const driverResult = (result as any)?.[0] ?? result;
  return Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) ===
    1;
}

export async function updateClaimedTask(
  id: number,
  executionToken: string,
  data: Partial<InsertTask>
): Promise<boolean> {
  const db = await getDb();
  if (!db || !executionToken) return false;
  const result = await db
    .update(taskQueue)
    .set(withTaskStatusTimestamp(data))
    .where(
      and(
        eq(taskQueue.id, id),
        eq(taskQueue.status, "in_progress"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${taskQueue.metadata}, '$.execution_claim_token')) = ${executionToken}`
      )
    );
  const driverResult = (result as any)?.[0] ?? result;
  return Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1;
}

export type RecoveredTaskLease = {
  taskId: number;
  actionType: string | null;
  disposition: "requeued" | "held_for_reconciliation";
  approvalFingerprint?: string;
  reconciliationId?: string;
};

type StaleTaskRecoveryDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select" | "update"
>;

export async function requeueStaleInProgressTasks(
  staleBefore: Date,
  databaseOverride?: StaleTaskRecoveryDatabase
): Promise<RecoveredTaskLease[]> {
  const db = databaseOverride ?? (await getDb());
  if (!db) return [];
  const staleTasks = await db
    .select({
      id: taskQueue.id,
      source: taskQueue.source,
      description: taskQueue.description,
      actionType: taskQueue.actionType,
      actionPayload: taskQueue.actionPayload,
      metadata: taskQueue.metadata,
      estimatedValue: taskQueue.estimatedValue,
    })
    .from(taskQueue)
    .where(
      and(
        eq(taskQueue.status, "in_progress"),
        lte(taskQueue.updatedAt, staleBefore)
      )
    );
  const recovered: RecoveredTaskLease[] = [];
  for (const task of staleTasks) {
    const requiresReconciliation = EXTERNAL_EFFECT_ACTION_TYPES.has(
      task.actionType || ""
    );
    const reconciliationId = requiresReconciliation ? randomUUID() : undefined;
    const reconciliationAt = new Date().toISOString();
    const reconciliationProvider =
      task.actionType === "outbound_call"
        ? "retell"
        : task.actionType === "send_email"
          ? "sendgrid"
          : task.actionType === "send_sms"
            ? "twilio"
            : undefined;
    const result = await db
      .update(taskQueue)
      .set({
        status: requiresReconciliation ? "awaiting_approval" : "pending",
        resultSummary: requiresReconciliation
          ? "Interrupted external action has an unknown provider outcome; reconcile before any retry"
          : "Recovered automatically after an interrupted execution lease expired",
        completedAt: null,
        metadata: requiresReconciliation
          ? sql`JSON_SET(JSON_REMOVE(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.execution_claim_token', '$.execution_claimed_at'), '$.external_outcome_reconciliation_required', true, '$.external_outcome_reconciliation_at', ${reconciliationAt}, '$.external_outcome_reconciliation_id', ${reconciliationId}, '$.external_outcome_provider', ${reconciliationProvider})`
          : sql`JSON_REMOVE(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.execution_claim_token', '$.execution_claimed_at', '$.external_outcome_reconciliation_required', '$.external_outcome_reconciliation_at', '$.external_outcome_reconciliation_id', '$.external_outcome_provider')`,
      })
      .where(
        and(
          eq(taskQueue.id, task.id),
          eq(taskQueue.status, "in_progress"),
          lte(taskQueue.updatedAt, staleBefore)
        )
      );
    const driverResult = (result as any)?.[0] ?? result;
    if (
      Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) ===
      1
    ) {
      recovered.push({
        taskId: task.id,
        actionType: task.actionType,
        disposition: requiresReconciliation
          ? "held_for_reconciliation"
          : "requeued",
        ...(requiresReconciliation
          ? {
              approvalFingerprint: externalTaskApprovalFingerprint(task),
              reconciliationId,
            }
          : {}),
      });
    }
  }
  return recovered;
}

export async function getRecentTasks(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskQueue).orderBy(desc(taskQueue.createdAt)).limit(limit);
}

export async function getCompletedTasksSince(since: Date) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskQueue)
    .where(and(eq(taskQueue.status, "completed"), gte(taskQueue.completedAt, since)))
    .orderBy(desc(taskQueue.completedAt));
}

// ─── Execution Log Helpers ──────────────────────────────────────────────────

export async function logExecution(entry: InsertExecutionLogEntry) {
  const db = await getDb();
  if (!db) return null;
  return db.insert(executionLog).values(entry);
}

export async function getRecentExecutions(limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(executionLog).orderBy(desc(executionLog.createdAt)).limit(limit);
}

export async function getExecutionsForTask(taskId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(executionLog)
    .where(eq(executionLog.taskId, taskId))
    .orderBy(desc(executionLog.createdAt), desc(executionLog.id));
}

// ─── Evaluations Helpers ────────────────────────────────────────────────────

export async function createEvaluation(evaluation: InsertEvaluation) {
  const db = await getDb();
  if (!db) return null;
  return db.insert(evaluations).values(evaluation);
}

export async function getRecentEvaluations(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(evaluations).orderBy(desc(evaluations.createdAt)).limit(limit);
}

// ─── Opportunities Helpers ──────────────────────────────────────────────────

export async function createOpportunity(opp: InsertOpportunity) {
  const db = await getDb();
  if (!db) return null;
  return db.insert(opportunities).values(opp);
}

export async function getOpportunities(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(opportunities).orderBy(desc(opportunities.detectedAt)).limit(limit);
}

export async function updateOpportunity(id: number, data: Partial<InsertOpportunity>) {
  const db = await getDb();
  if (!db) return;
  await db.update(opportunities).set(data).where(eq(opportunities.id, id));
}

// ─── System Config Helpers ──────────────────────────────────────────────────

export async function getConfig(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const results = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  return results[0]?.value ?? null;
}

export async function getAllConfig() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(systemConfig);
}

export async function setConfig(key: string, value: string, description?: string) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  if (existing.length > 0) {
    await db.update(systemConfig).set({ value }).where(eq(systemConfig.key, key));
  } else {
    await db.insert(systemConfig).values({ key, value, description });
  }
}

export type InboundSmsLease =
  | { disposition: "acquired"; token: string; leaseUntil: string }
  | { disposition: "processing" }
  | { disposition: "completed" }
  | { disposition: "invalid" };

type InboundSmsLeaseDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "insert" | "select" | "update"
>;

type InboundSmsLeaseValue = {
  version: 1;
  state: "processing" | "completed";
  token?: string;
  leaseUntil?: string;
  completedAt?: string;
};

function inboundSmsKey(messageSid: string): string | null {
  if (!/^SM[a-fA-F0-9]{32}$/.test(messageSid)) return null;
  const digest = createHash("sha256").update(messageSid, "utf8").digest("hex");
  return `processed_sms_${digest}`;
}

function parseInboundSmsLeaseValue(value: string): InboundSmsLeaseValue | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      (parsed.state !== "processing" && parsed.state !== "completed")
    ) {
      return null;
    }
    return parsed as InboundSmsLeaseValue;
  } catch {
    return null;
  }
}

/**
 * Atomically leases an authenticated Twilio message SID. Processing and
 * completion are distinct, so a crash cannot permanently consume STOP before
 * its durable pause effect. Legacy timestamp-only claims remain completed.
 */
export async function acquireInboundSms(
  messageSid: string,
  now = new Date(),
  leaseMs = 10 * 60_000,
  databaseOverride?: InboundSmsLeaseDatabase
): Promise<InboundSmsLease> {
  const key = inboundSmsKey(messageSid);
  if (
    !key ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 30_000 ||
    leaseMs > 60 * 60_000
  ) {
    return { disposition: "invalid" };
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");

  const createProcessingValue = () => {
    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const value = JSON.stringify({
      version: 1,
      state: "processing",
      token,
      leaseUntil,
    } satisfies InboundSmsLeaseValue);
    return { token, leaseUntil, value };
  };
  const created = createProcessingValue();
  try {
    await db.insert(systemConfig).values({
      key,
      value: created.value,
      description: "Authenticated Twilio inbound message processing lease",
    });
    return {
      disposition: "acquired",
      token: created.token,
      leaseUntil: created.leaseUntil,
    };
  } catch (error) {
    if (!isMysqlDuplicateKeyError(error)) throw error;
  }

  const rows = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  const storedValue = rows[0]?.value;
  if (typeof storedValue !== "string") {
    throw new Error("Inbound SMS lease disappeared during acquisition");
  }
  const stored = parseInboundSmsLeaseValue(storedValue);
  // Timestamp-only values were written by the previous permanent dedupe
  // implementation and represent already-processed historical messages.
  if (!stored || stored.state === "completed") {
    return { disposition: "completed" };
  }
  const leaseUntilMs = Date.parse(stored.leaseUntil || "");
  if (Number.isFinite(leaseUntilMs) && leaseUntilMs > now.getTime()) {
    return { disposition: "processing" };
  }

  const replacement = createProcessingValue();
  const result = await db
    .update(systemConfig)
    .set({ value: replacement.value })
    .where(and(eq(systemConfig.key, key), eq(systemConfig.value, storedValue)));
  const driverResult = (result as any)?.[0] ?? result;
  if (
    Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) !== 1
  ) {
    return { disposition: "processing" };
  }
  return {
    disposition: "acquired",
    token: replacement.token,
    leaseUntil: replacement.leaseUntil,
  };
}

/** Complete only the exact active inbound-SMS processing lease. */
export async function completeInboundSms(
  messageSid: string,
  token: string,
  now = new Date(),
  databaseOverride?: InboundSmsLeaseDatabase
): Promise<boolean> {
  const key = inboundSmsKey(messageSid);
  if (
    !key ||
    !APPROVAL_REQUEST_ID_PATTERN.test(token) ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  const db = databaseOverride ?? (await getDb());
  if (!db) throw new Error("Database is not available");
  const rows = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(eq(systemConfig.key, key))
    .limit(1);
  const storedValue = rows[0]?.value;
  if (typeof storedValue !== "string") return false;
  const stored = parseInboundSmsLeaseValue(storedValue);
  if (
    !stored ||
    stored.state !== "processing" ||
    stored.token !== token
  ) {
    return false;
  }
  const completedValue = JSON.stringify({
    version: 1,
    state: "completed",
    completedAt: now.toISOString(),
  } satisfies InboundSmsLeaseValue);
  const result = await db
    .update(systemConfig)
    .set({ value: completedValue })
    .where(and(eq(systemConfig.key, key), eq(systemConfig.value, storedValue)));
  const driverResult = (result as any)?.[0] ?? result;
  return (
    Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1
  );
}

/**
 * Atomically consumes a private-owner bootstrap token across deployments.
 * Only a SHA-256 digest is stored; the credential itself is never persisted.
 */
export async function claimPrivateOwnerAccessToken(
  jti: string,
  expiresAt: Date
): Promise<boolean> {
  if (!jti || jti.length > 256 || !Number.isFinite(expiresAt.getTime())) {
    return false;
  }
  const db = await getDb();
  if (!db) return false;

  const digest = createHash("sha256").update(jti, "utf8").digest("hex");
  try {
    await db.insert(systemConfig).values({
      key: `private_owner_access_${digest}`,
      value: expiresAt.toISOString(),
      description: "Consumed one-time private owner access credential",
    });
    return true;
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) return false;
    throw error;
  }
}

/**
 * Atomically claims one scheduler job/time slot across every live instance.
 * Railway can briefly run old and new instances together during a deployment,
 * so process-local timers alone cannot prevent a duplicate cycle.
 */
export async function claimPrivateCandidateJobSlot(
  job: "task-generator" | "task-executor" | "evaluator" | "self-improver",
  slot: string
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}(?::\d{2})?)?$/.test(slot)) {
    return false;
  }

  const db = await getDb();
  if (!db) return false;

  const digest = createHash("sha256")
    .update(`${job}:${slot}`, "utf8")
    .digest("hex");

  try {
    await db.insert(systemConfig).values({
      key: `private_scheduler_claim_${digest}`,
      value: `${job}:${slot}`,
      description: "Distributed private-candidate scheduler slot claim",
    });
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) return false;
    const mysqlError = error as { code?: string; errno?: number };
    if (mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062) {
      return false;
    }
    throw error;
  }

  const retentionCutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await db
    .delete(systemConfig)
    .where(
      and(
        like(systemConfig.key, "private_scheduler_claim_%"),
        lte(systemConfig.updatedAt, retentionCutoff)
      )
    )
    .catch(error => {
      console.warn("[Database] Scheduler-claim retention cleanup failed:", error);
    });
  return true;
}

// ─── Daily Metrics Helpers ──────────────────────────────────────────────────

export type DailyTaskActivity = {
  tasksGenerated: number;
  tasksCompleted: number;
  tasksFailed: number;
};

export type DailyTaskCountRow = {
  date: string | null;
  count: number | string;
};

export function mergeDailyTaskActivity(
  generatedRows: DailyTaskCountRow[],
  completedRows: DailyTaskCountRow[],
  failedRows: DailyTaskCountRow[]
): Map<string, DailyTaskActivity> {
  const activity = new Map<string, DailyTaskActivity>();
  const ensure = (date: string): DailyTaskActivity => {
    const existing = activity.get(date);
    if (existing) return existing;
    const created = {
      tasksGenerated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    };
    activity.set(date, created);
    return created;
  };
  const apply = (
    rows: DailyTaskCountRow[],
    key: keyof DailyTaskActivity
  ) => {
    for (const row of rows) {
      if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
      const count = Number(row.count);
      if (!Number.isFinite(count) || count < 0) continue;
      ensure(row.date)[key] = count;
    }
  };
  apply(generatedRows, "tasksGenerated");
  apply(completedRows, "tasksCompleted");
  apply(failedRows, "tasksFailed");
  return activity;
}

async function getDailyTaskActivity(
  since: Date
): Promise<Map<string, DailyTaskActivity>> {
  const db = await getDb();
  if (!db) return new Map();

  const sinceEpoch = Math.floor(since.getTime() / 1000);
  const sinceInstant = sql`from_unixtime(${sinceEpoch})`;
  const generatedDate =
    sql<string>`date_format(convert_tz(${taskQueue.createdAt}, @@session.time_zone, '+00:00'), '%Y-%m-%d')`;
  const completedDate =
    sql<string>`date_format(convert_tz(${taskQueue.completedAt}, @@session.time_zone, '+00:00'), '%Y-%m-%d')`;
  const failedDate =
    sql<string>`date_format(convert_tz(${executionLog.createdAt}, @@session.time_zone, '+00:00'), '%Y-%m-%d')`;
  const [generatedRows, completedRows, failedRows] = await Promise.all([
    db
      .select({
        date: generatedDate,
        count: sql<number>`count(*)`,
      })
      .from(taskQueue)
      .where(
        and(
          eq(taskQueue.source, "task_generator"),
          sql`${taskQueue.createdAt} >= ${sinceInstant}`
        )
      )
      .groupBy(generatedDate),
    db
      .select({
        date: completedDate,
        count: sql<number>`count(*)`,
      })
      .from(taskQueue)
      .where(
        and(
          eq(taskQueue.status, "completed"),
          isNotNull(taskQueue.completedAt),
          sql`${taskQueue.completedAt} >= ${sinceInstant}`
        )
      )
      .groupBy(completedDate),
    db
      .select({
        date: failedDate,
        count: sql<number>`count(distinct ${executionLog.taskId})`,
      })
      .from(executionLog)
      .where(
        and(
          eq(executionLog.outcome, "failure"),
          isNotNull(executionLog.taskId),
          sql`${executionLog.createdAt} >= ${sinceInstant}`
        )
      )
      .groupBy(failedDate),
  ]);
  return mergeDailyTaskActivity(generatedRows, completedRows, failedRows);
}

export function withTaskActivity(
  row: DailyMetric | undefined,
  date: string,
  activity: DailyTaskActivity | undefined
): DailyMetric {
  return {
    ...(row || {
      id: 0,
      date,
      tasksGenerated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      callsMade: 0,
      emailsSent: 0,
      smsSent: 0,
      apiSpendCents: 0,
      successRate: null,
      createdAt: new Date(`${date}T00:00:00.000Z`),
    }),
    tasksGenerated: activity?.tasksGenerated || 0,
    tasksCompleted: activity?.tasksCompleted || 0,
    tasksFailed: activity?.tasksFailed || 0,
  };
}

export async function getTodayMetrics(): Promise<DailyMetric | null> {
  const db = await getDb();
  if (!db) return null;
  const today = new Date().toISOString().split("T")[0];
  const since = new Date(`${today}T00:00:00.000Z`);
  const [results, taskActivity] = await Promise.all([
    db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.date, today))
      .limit(1),
    getDailyTaskActivity(since),
  ]);
  return withTaskActivity(results[0], today, taskActivity.get(today));
}

export async function getTodayApiSpendCents(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const today = new Date().toISOString().split("T")[0];
  const results = await db
    .select({ apiSpendCents: dailyMetrics.apiSpendCents })
    .from(dailyMetrics)
    .where(eq(dailyMetrics.date, today))
    .limit(1);
  return results[0]?.apiSpendCents || 0;
}

export async function upsertDailyMetrics(date: string, data: Partial<InsertDailyMetric>) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(dailyMetrics).where(eq(dailyMetrics.date, date)).limit(1);
  if (existing.length > 0) {
    await db.update(dailyMetrics).set(data).where(eq(dailyMetrics.date, date));
  } else {
    await db.insert(dailyMetrics).values({ date, ...data } as InsertDailyMetric);
  }
}

export async function getRecentMetrics(days = 30) {
  const db = await getDb();
  if (!db) return [];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  const firstDate = start.toISOString().split("T")[0];
  const [storedRows, taskActivity] = await Promise.all([
    db
      .select()
      .from(dailyMetrics)
      .where(gte(dailyMetrics.date, firstDate))
      .orderBy(desc(dailyMetrics.date))
      .limit(days),
    getDailyTaskActivity(start),
  ]);
  const storedByDate = new Map(storedRows.map(row => [row.date, row]));
  const dates = new Set([
    ...Array.from(storedByDate.keys()),
    ...Array.from(taskActivity.keys()),
  ]);
  return Array.from(dates)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, days)
    .map(date =>
      withTaskActivity(storedByDate.get(date), date, taskActivity.get(date))
    );
}

// ─── Safety Check Helpers ───────────────────────────────────────────────────

export async function getDailyCallCount(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const today = new Date().toISOString().split("T")[0];
  const results = await db.select({ count: sql<number>`count(*)` })
    .from(executionLog)
    .where(and(
      eq(executionLog.actionType, "outbound_call"),
      gte(executionLog.createdAt, new Date(today))
    ));
  return results[0]?.count ?? 0;
}

export async function getDailyEmailCount(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const today = new Date().toISOString().split("T")[0];
  const results = await db.select({ count: sql<number>`count(*)` })
    .from(executionLog)
    .where(and(
      eq(executionLog.actionType, "send_email"),
      gte(executionLog.createdAt, new Date(today))
    ));
  return results[0]?.count ?? 0;
}

export async function isKillSwitchActive(): Promise<boolean> {
  const val = await getConfig("kill_switch_active");
  return val !== "false";
}
