import { eq, desc, asc, and, sql, gte, lte, like } from "drizzle-orm";
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
  dailyMetrics, InsertDailyMetric,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

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

export async function updateTask(id: number, data: Partial<InsertTask>) {
  const db = await getDb();
  if (!db) return;
  await db.update(taskQueue).set(data).where(eq(taskQueue.id, id));
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
    const mysqlError = error as { code?: string; errno?: number };
    if (mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062) {
      return false;
    }
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

export async function getTodayMetrics(): Promise<any> {
  const db = await getDb();
  if (!db) return null;
  const today = new Date().toISOString().split("T")[0];
  const results = await db.select().from(dailyMetrics).where(eq(dailyMetrics.date, today)).limit(1);
  return results[0] || null;
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
  return db.select().from(dailyMetrics).orderBy(desc(dailyMetrics.date)).limit(days);
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
