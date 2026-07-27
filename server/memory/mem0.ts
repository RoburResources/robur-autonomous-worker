/**
 * Mem0 Memory Integration
 *
 * Provides persistent memory for the autonomous worker across execution cycles.
 * Uses Mem0's hosted API (if MEM0_API_KEY is set) or falls back to a local
 * database-backed memory store using the system_config table.
 *
 * Memory categories:
 * - supplier_preferences: contact time, response rate, channel preference per supplier
 * - task_outcomes: what worked, what failed, patterns across task types
 * - strategy_insights: winning approaches discovered by the self-improver
 * - contact_history: who was contacted, when, outcome
 * - market_intelligence: pricing, demand signals, competitor activity
 */

import { getDb } from "../db";
import { systemConfig } from "../../drizzle/schema";
import { eq, like } from "drizzle-orm";
import { invokeLLM } from "../_core/llm";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_BASE_URL = "https://api.mem0.ai";
const AGENT_ID = "robur-autonomous-worker";

// Memory entry shape
export interface MemoryEntry {
  id?: string;
  content: string;
  category: MemoryCategory;
  entityId?: string; // supplier ID, task ID, contact name, etc.
  metadata?: Record<string, unknown>;
  score?: number; // relevance score from search
  createdAt?: string;
}

export type MemoryCategory =
  | "supplier_preferences"
  | "task_outcomes"
  | "strategy_insights"
  | "contact_history"
  | "market_intelligence"
  | "system_learnings";

// ─────────────────────────────────────────────────────────────────────────────
// Mem0 API client (hosted)
// ─────────────────────────────────────────────────────────────────────────────

async function mem0ApiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  if (!MEM0_API_KEY) throw new Error("MEM0_API_KEY not configured");

  const response = await fetch(`${MEM0_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Token ${MEM0_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Mem0 API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Local fallback: DB-backed memory using system_config table
// ─────────────────────────────────────────────────────────────────────────────

async function localMemoryAdd(entry: MemoryEntry): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const key = `memory:${entry.category}:${id}`;
  const val = JSON.stringify({
    id,
    content: entry.content,
    category: entry.category,
    entityId: entry.entityId,
    metadata: entry.metadata || {},
    createdAt: new Date().toISOString(),
  });

  await db.insert(systemConfig).values({
    key,
    value: val,
    description: `Memory: ${entry.category}`,
  }).onDuplicateKeyUpdate({ set: { value: val } });

  return id;
}

async function localMemorySearch(
  query: string,
  category?: MemoryCategory,
  limit = 5
): Promise<MemoryEntry[]> {
  const db = await getDb();
  if (!db) return [];

  const pattern = category ? `memory:${category}:%` : "memory:%";
  const rows = await db
    .select()
    .from(systemConfig)
    .where(like(systemConfig.key, pattern))
    .limit(50); // fetch more, then rank with LLM

  if (rows.length === 0) return [];

  // Parse all memory entries
  const entries: MemoryEntry[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value);
      entries.push(parsed as MemoryEntry);
    } catch {
      // skip malformed
    }
  }

  if (entries.length === 0) return [];

  // Use LLM to rank by relevance to query
  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `You are a memory retrieval system. Given a query and a list of memory entries, return the indices of the top ${limit} most relevant entries. Return ONLY a JSON array of indices (0-based), e.g. [2, 0, 4].`,
        },
        {
          role: "user",
          content: `Query: "${query}"\n\nMemories:\n${entries
            .slice(0, 30)
            .map((e, i) => `[${i}] ${e.content}`)
            .join("\n")}`,
        },
      ],
    });

    const rawContent = response.choices[0]?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : "[]";
    const match = content.match(/\[[\d,\s]+\]/);
    if (match) {
      const indices: number[] = JSON.parse(match[0]);
      return indices
        .filter((i) => i >= 0 && i < entries.length)
        .slice(0, limit)
        .map((i) => ({ ...entries[i], score: 1 - i * 0.1 }));
    }
  } catch {
    // fallback: return most recent
  }

  return entries.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — auto-selects Mem0 hosted or local fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store a memory. Uses Mem0 hosted API if MEM0_API_KEY is set, otherwise
 * falls back to local DB-backed storage.
 */
export async function addMemory(entry: MemoryEntry): Promise<string> {
  try {
    if (MEM0_API_KEY) {
      const result = (await mem0ApiRequest("POST", "/v3/memories/add/", {
        messages: [
          { role: "user", content: entry.content },
          {
            role: "assistant",
            content: `Memory stored in category: ${entry.category}`,
          },
        ],
        agent_id: AGENT_ID,
        metadata: {
          category: entry.category,
          entityId: entry.entityId,
          ...entry.metadata,
        },
      })) as { id?: string };
      return result?.id || "unknown";
    } else {
      return await localMemoryAdd(entry);
    }
  } catch (error: any) {
    console.warn("[Mem0] addMemory failed, using local fallback:", error.message);
    return await localMemoryAdd(entry);
  }
}

/**
 * Search memories by semantic query. Returns top-k relevant memories.
 */
export async function searchMemories(
  query: string,
  options: {
    category?: MemoryCategory;
    entityId?: string;
    limit?: number;
  } = {}
): Promise<MemoryEntry[]> {
  const { category, entityId, limit = 5 } = options;

  try {
    if (MEM0_API_KEY) {
      const filters: Record<string, unknown> = { agent_id: AGENT_ID };
      if (category) filters.category = category;
      if (entityId) filters.entityId = entityId;

      const result = (await mem0ApiRequest("POST", "/v3/memories/search/", {
        query,
        filters,
        top_k: limit,
      })) as { results?: Array<{ id: string; memory: string; score: number; metadata?: Record<string, unknown> }> };

      return (result?.results || []).map((r) => ({
        id: r.id,
        content: r.memory,
        category: (r.metadata?.category as MemoryCategory) || "system_learnings",
        entityId: r.metadata?.entityId as string | undefined,
        metadata: r.metadata,
        score: r.score,
      }));
    } else {
      return await localMemorySearch(query, category, limit);
    }
  } catch (error: any) {
    console.warn("[Mem0] searchMemories failed, using local fallback:", error.message);
    return await localMemorySearch(query, category, limit);
  }
}

/**
 * Store a task outcome as a memory for future reference.
 * Called after every task execution.
 */
export async function storeTaskOutcome(params: {
  taskId: number;
  description: string;
  actionType: string;
  outcome: "success" | "failure" | "partial";
  resultSummary: string;
  confidence: number;
  executionTimeMs?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const {
    taskId,
    description,
    actionType,
    outcome,
    resultSummary,
    confidence,
    executionTimeMs,
    metadata,
  } = params;

  const content = `Task [${actionType}] "${description}" — ${outcome.toUpperCase()}. Result: ${resultSummary}. Confidence: ${Math.round(confidence * 100)}%.${executionTimeMs ? ` Took ${Math.round(executionTimeMs / 1000)}s.` : ""}`;

  await addMemory({
    content,
    category: "task_outcomes",
    entityId: String(taskId),
    metadata: {
      taskId,
      actionType,
      outcome,
      confidence,
      executionTimeMs,
      ...metadata,
    },
  });
}

/**
 * Store a supplier/contact interaction as a memory.
 */
export async function storeContactInteraction(params: {
  contactName: string;
  contactType: "supplier" | "buyer" | "agent" | "unknown";
  channel: "phone" | "email" | "sms";
  outcome: "connected" | "no_answer" | "rejected" | "interested" | "not_interested";
  notes?: string;
  bestContactTime?: string;
}): Promise<void> {
  const { contactName, contactType, channel, outcome, notes, bestContactTime } = params;

  const content = `${contactType} "${contactName}" contacted via ${channel}: ${outcome}.${notes ? ` Notes: ${notes}` : ""}${bestContactTime ? ` Best contact time: ${bestContactTime}.` : ""}`;

  await addMemory({
    content,
    category: "contact_history",
    entityId: contactName.toLowerCase().replace(/\s+/g, "_"),
    metadata: { contactName, contactType, channel, outcome, bestContactTime },
  });

  // Also store as supplier preference if we learned something
  if (outcome === "connected" || outcome === "interested") {
    await addMemory({
      content: `${contactName} responds well to ${channel} contact${bestContactTime ? ` at ${bestContactTime}` : ""}.`,
      category: "supplier_preferences",
      entityId: contactName.toLowerCase().replace(/\s+/g, "_"),
      metadata: { contactName, preferredChannel: channel, bestContactTime },
    });
  }
}

/**
 * Store a strategy insight from the self-improver.
 */
export async function storeStrategyInsight(params: {
  insight: string;
  evidence: string;
  actionType?: string;
  confidenceLevel: "high" | "medium" | "low";
}): Promise<void> {
  const { insight, evidence, actionType, confidenceLevel } = params;

  const content = `STRATEGY INSIGHT [${confidenceLevel.toUpperCase()}]: ${insight}. Evidence: ${evidence}.`;

  await addMemory({
    content,
    category: "strategy_insights",
    entityId: actionType,
    metadata: { insight, evidence, actionType, confidenceLevel },
  });
}

/**
 * Get relevant context for a task before execution.
 * Returns formatted memory context string for injection into LLM prompts.
 */
export async function getTaskContext(params: {
  taskDescription: string;
  actionType: string;
  entityId?: string;
}): Promise<string> {
  const { taskDescription, actionType, entityId } = params;

  const memories: MemoryEntry[] = [];

  // Search for relevant task outcomes
  const outcomeMemories = await searchMemories(taskDescription, {
    category: "task_outcomes",
    limit: 3,
  });
  memories.push(...outcomeMemories);

  // Search for strategy insights for this action type
  const strategyMemories = await searchMemories(
    `${actionType} strategy best approach`,
    { category: "strategy_insights", limit: 2 }
  );
  memories.push(...strategyMemories);

  // If entity-specific, get contact history
  if (entityId) {
    const contactMemories = await searchMemories(entityId, {
      category: "contact_history",
      entityId,
      limit: 2,
    });
    memories.push(...contactMemories);

    const prefMemories = await searchMemories(entityId, {
      category: "supplier_preferences",
      entityId,
      limit: 2,
    });
    memories.push(...prefMemories);
  }

  if (memories.length === 0) return "";

  const unique = Array.from(
    new Map(memories.map((m) => [m.content, m])).values()
  ).slice(0, 7);

  return `\n\nRELEVANT MEMORY CONTEXT (from previous cycles):\n${unique
    .map((m) => `- [${m.category}] ${m.content}`)
    .join("\n")}`;
}

/**
 * Get supplier-specific preferences and history.
 */
export async function getSupplierContext(supplierName: string): Promise<string> {
  const memories = await searchMemories(supplierName, {
    entityId: supplierName.toLowerCase().replace(/\s+/g, "_"),
    limit: 5,
  });

  if (memories.length === 0) return "";

  return `\n\nSUPPLIER MEMORY (${supplierName}):\n${memories
    .map((m) => `- ${m.content}`)
    .join("\n")}`;
}
