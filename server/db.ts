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
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
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
      outcome: "updated";
      previousStatus: Task["status"];
      nextStatus: Task["status"];
      statusChanged: boolean;
    };

type OwnerTaskUpdateDatabase = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "transaction"
>;

export async function updateTaskByOwnerWithAudit(
  id: number,
  data: Partial<Pick<InsertTask, "status" | "priorityScore">>,
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

export async function claimPendingTask(
  id: number,
  executionToken: string
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
    .where(and(eq(taskQueue.id, id), eq(taskQueue.status, "pending")));
  const driverResult = (result as any)?.[0] ?? result;
  return Number(driverResult?.affectedRows ?? driverResult?.rowsAffected ?? 0) === 1;
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

export async function requeueStaleInProgressTasks(
  staleBefore: Date
): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  const staleTasks = await db
    .select({ id: taskQueue.id })
    .from(taskQueue)
    .where(
      and(
        eq(taskQueue.status, "in_progress"),
        lte(taskQueue.updatedAt, staleBefore)
      )
    );
  const recovered: number[] = [];
  for (const task of staleTasks) {
    const result = await db
      .update(taskQueue)
      .set({
        status: "pending",
        resultSummary:
          "Recovered automatically after an interrupted execution lease expired",
        completedAt: null,
        metadata: sql`JSON_REMOVE(COALESCE(${taskQueue.metadata}, JSON_OBJECT()), '$.execution_claim_token', '$.execution_claimed_at')`,
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
      recovered.push(task.id);
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
  return db.select().from(executionLog).where(eq(executionLog.taskId, taskId)).orderBy(desc(executionLog.createdAt));
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

/**
 * Atomically claim an authenticated Twilio message SID. The unique config key
 * makes replayed signed webhooks harmless, including replays after a restart.
 * The raw provider identifier is not persisted.
 */
export async function claimInboundSms(messageSid: string): Promise<boolean> {
  if (!/^SM[a-fA-F0-9]{32}$/.test(messageSid)) return false;
  const db = await getDb();
  if (!db) return false;

  const digest = createHash("sha256").update(messageSid, "utf8").digest("hex");
  try {
    await db.insert(systemConfig).values({
      key: `processed_sms_${digest}`,
      value: new Date().toISOString(),
      description: "Authenticated Twilio inbound message replay claim",
    });
    return true;
  } catch (error) {
    if (isMysqlDuplicateKeyError(error)) return false;
    const mysqlError = error as { code?: string; errno?: number };
    if (mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062) {
      return false;
    }
    throw error;
  }
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
