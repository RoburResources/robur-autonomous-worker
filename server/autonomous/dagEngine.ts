import { getDb } from "../db";
import { taskQueue } from "../../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";

export interface DagNode {
  taskId: number;
  description: string;
  status: string;
  priorityScore: number;
  dependencies: number[];  // task IDs that must be completed first
  dependents: number[];    // task IDs that depend on this task
}

export interface DagReadinessResult {
  isReady: boolean;
  blockedBy: number[];     // task IDs blocking this task
  blockedByDescriptions: string[];
}

/**
 * DAG Dependency Graph Engine
 *
 * Replaces the flat priority queue with a directed acyclic graph (DAG)
 * where tasks declare their dependencies explicitly. A task is only
 * eligible for execution when ALL its dependencies are in "completed" state.
 *
 * Dependencies are stored in task metadata as:
 *   metadata.dag_dependencies: number[]  (array of task IDs)
 *
 * This prevents the entire class of errors caused by executing tasks
 * out of order or on stale/incomplete data.
 */
export async function checkDagReadiness(task: {
  id: number;
  metadata?: unknown;
}): Promise<DagReadinessResult> {
  const meta = task.metadata as Record<string, unknown> | null;
  const dependencies: number[] = (meta?.dag_dependencies as number[]) || [];

  if (dependencies.length === 0) {
    return { isReady: true, blockedBy: [], blockedByDescriptions: [] };
  }

  const db = await getDb();
  if (!db) {
    return { isReady: false, blockedBy: dependencies, blockedByDescriptions: ["Database unavailable"] };
  }

  // Fetch the status of all dependency tasks
  const depTasks = await db
    .select({ id: taskQueue.id, status: taskQueue.status, description: taskQueue.description })
    .from(taskQueue)
    .where(inArray(taskQueue.id, dependencies));

  const blockedBy: number[] = [];
  const blockedByDescriptions: string[] = [];

  for (const dep of depTasks) {
    if (dep.status !== "completed") {
      blockedBy.push(dep.id);
      blockedByDescriptions.push(`Task #${dep.id} (${dep.status}): ${dep.description.substring(0, 80)}`);
    }
  }

  // Also check for dependency task IDs that don't exist in the DB
  const foundIds = new Set(depTasks.map(t => t.id));
  for (const depId of dependencies) {
    if (!foundIds.has(depId)) {
      blockedBy.push(depId);
      blockedByDescriptions.push(`Task #${depId}: not found in database`);
    }
  }

  return {
    isReady: blockedBy.length === 0,
    blockedBy,
    blockedByDescriptions,
  };
}

/**
 * Get the next executable task using DAG-aware selection.
 *
 * Unlike the flat queue (highest priority score), this:
 * 1. Filters to only tasks where all dependencies are completed
 * 2. Among those, picks the highest priority score
 * 3. Returns null if no tasks are DAG-ready
 */
export async function getDagReadyTask(): Promise<{
  id: number;
  description: string;
  priorityScore: number;
  status: string;
  actionType: string | null;
  actionPayload: unknown;
  resultSummary: string | null;
  metadata: unknown;
  estimatedValue: string | null;
  goalId: number | null;
  source: string;
  assignedAgent: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const db = await getDb();
  if (!db) return null;

  // Get all pending tasks ordered by priority
  const pendingTasks = await db
    .select()
    .from(taskQueue)
    .where(eq(taskQueue.status, "pending"))
    .orderBy(taskQueue.priorityScore);

  // Find the first one that is DAG-ready
  for (const task of pendingTasks.reverse()) {  // highest priority first
    const readiness = await checkDagReadiness(task);
    if (readiness.isReady) {
      return task as any;
    }
  }

  return null;
}

/**
 * When a task completes, unlock any tasks that were waiting on it.
 * Updates blocked tasks to "pending" if all their other dependencies are now met.
 */
export async function unlockDependents(completedTaskId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];

  // Find all pending tasks that have this task as a dependency
  const allPending = await db
    .select()
    .from(taskQueue)
    .where(eq(taskQueue.status, "pending"));

  const unlocked: number[] = [];

  for (const task of allPending) {
    const meta = task.metadata as Record<string, unknown> | null;
    const deps: number[] = (meta?.dag_dependencies as number[]) || [];

    if (deps.includes(completedTaskId)) {
      // Check if ALL other dependencies are now complete
      const readiness = await checkDagReadiness(task);
      if (readiness.isReady) {
        unlocked.push(task.id);
      }
    }
  }

  return unlocked;
}

/**
 * Validate that a proposed dependency list does not create a cycle.
 * Uses depth-first search to detect cycles.
 */
export async function validateNoCycle(
  taskId: number,
  proposedDependencies: number[]
): Promise<{ valid: boolean; cycleDescription?: string }> {
  const db = await getDb();
  if (!db) return { valid: true };  // Can't validate without DB, allow optimistically

  // Build adjacency map: taskId -> its dependencies
  const allTasks = await db.select({ id: taskQueue.id, metadata: taskQueue.metadata }).from(taskQueue);
  const depMap = new Map<number, number[]>();

  for (const t of allTasks) {
    const meta = t.metadata as Record<string, unknown> | null;
    depMap.set(t.id, (meta?.dag_dependencies as number[]) || []);
  }

  // Add proposed dependencies for the new task
  depMap.set(taskId, proposedDependencies);

  // DFS cycle detection
  const visited = new Set<number>();
  const inStack = new Set<number>();

  function hasCycle(node: number): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    for (const dep of depMap.get(node) || []) {
      if (hasCycle(dep)) return true;
    }

    inStack.delete(node);
    return false;
  }

  if (hasCycle(taskId)) {
    return {
      valid: false,
      cycleDescription: `Adding dependencies ${proposedDependencies.join(", ")} to task #${taskId} would create a cycle`,
    };
  }

  return { valid: true };
}
