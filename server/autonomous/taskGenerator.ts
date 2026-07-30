import { invokeLLM } from "../_core/llm";
import { getActiveGoals, createTask, getConfig, getRecentTasks, logExecution, updateTask } from "../db";
import { linkBatchDependencies } from "./dependencyLinker";
import { searchMemories } from "../memory/mem0";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";
import {
  PRIVATE_RESEARCH_COMPLETION_CONTRACT_VERSION,
  withPrivateResearchEvidenceContract,
  withoutPrivateResearchBoilerplateForNovelty,
} from "./researchCompletionContract";

export { withPrivateResearchEvidenceContract } from "./researchCompletionContract";

const TASK_DESCRIPTION_STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "for", "from",
  "in", "into", "is", "it", "of", "on", "or", "that", "the", "their", "to",
  "using", "with",
]);
const TASK_DESCRIPTION_EXCLUSIVE_SCOPE_GROUPS = [
  new Set(["public", "private"]),
  new Set(["contact", "research"]),
];

function taskDescriptionTokens(description: string): string[] {
  return withoutPrivateResearchBoilerplateForNovelty(description)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(token => token.length >= 3 && !TASK_DESCRIPTION_STOP_WORDS.has(token))
    .map(token =>
      token.length > 5 && token.endsWith("s") ? token.slice(0, -1) : token
    );
}

export function taskDescriptionsOverlap(
  candidate: string,
  existing: string
): boolean {
  const candidateTokens = new Set(taskDescriptionTokens(candidate));
  const existingTokens = new Set(taskDescriptionTokens(existing));
  if (candidateTokens.size === 0 || existingTokens.size === 0) return false;
  const hasExclusiveScopeConflict =
    TASK_DESCRIPTION_EXCLUSIVE_SCOPE_GROUPS.some(group => {
      const candidateScope = Array.from(group).filter(token =>
        candidateTokens.has(token)
      );
      const existingScope = Array.from(group).filter(token =>
        existingTokens.has(token)
      );
      return (
        candidateScope.length > 0 &&
        existingScope.length > 0 &&
        !candidateScope.some(token => existingScope.includes(token))
      );
    });
  if (hasExclusiveScopeConflict) return false;

  const candidateKey = Array.from(candidateTokens).sort().join(" ");
  const existingKey = Array.from(existingTokens).sort().join(" ");
  if (candidateKey === existingKey) return true;

  const intersection = Array.from(candidateTokens).filter(token =>
    existingTokens.has(token)
  ).length;
  const containment =
    intersection / Math.min(candidateTokens.size, existingTokens.size);
  const union = new Set([
    ...Array.from(candidateTokens),
    ...Array.from(existingTokens),
  ]).size;
  const jaccard = intersection / union;

  return intersection >= 6 && (containment >= 0.72 || jaccard >= 0.55);
}

/**
 * Task Generator — runs every 15 minutes
 * Queries active goals, decomposes them into prioritized tasks using LLM.
 * Features:
 * - Max 5 tasks per cycle (prevents over-generation)
 * - Minimum 60% internal tasks (no external contact)
 * - Phase awareness (Phase 1 tasks before Phase 2)
 * - ROI scoring
 * - Dependency awareness
 */
export async function runTaskGenerator(): Promise<{ tasksCreated: number; error?: string }> {
  try {
    // Safety check
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { tasksCreated: 0, error: gate.reason || "Legacy worker is unavailable" };
    }

    const activeGoals = await getActiveGoals();
    if (activeGoals.length === 0) {
      return { tasksCreated: 0, error: "No active goals" };
    }

    const privateCandidate = isPrivateCandidateInternalOnly();

    // Get recent tasks to avoid duplication and bound the live backlog.
    const recentTasks = await getRecentTasks(100);
    const recentDescriptions = recentTasks.map(t => t.description).slice(0, 30).join("\n- ");
    const pendingCount = recentTasks.filter(t => t.status === "pending").length;

    const model = (await getConfig("task_generation_model")) || "gpt-4o-mini";
    const maxTasksPerCycle = parseInt(await getConfig("max_tasks_per_generation_cycle") || "5");
    const minInternalRatio = parseFloat(await getConfig("min_internal_task_ratio") || "0.6");
    const queueHighWaterMark = parseInt(
      (await getConfig("max_pending_tasks_before_generation")) ||
        (privateCandidate ? "5" : "30")
    );
    if (
      !Number.isFinite(queueHighWaterMark) ||
      queueHighWaterMark < 1 ||
      pendingCount >= queueHighWaterMark
    ) {
      return {
        tasksCreated: 0,
        error:
          !Number.isFinite(queueHighWaterMark) || queueHighWaterMark < 1
            ? "Invalid max_pending_tasks_before_generation config"
            : `Queue already has ${pendingCount} pending tasks (limit ${queueHighWaterMark}) — skipping generation`,
      };
    }
    const generationCapacity = Math.min(
      maxTasksPerCycle,
      queueHighWaterMark - pendingCount
    );

    // Load constitution context
    const constitution = await getConfig("constitution_principles") || "";
    const safetyRules = await getConfig("constitution_safety_rules") || "";
    const scrapStrategy = await getConfig("scrap_metal_strategy") || "";
    const topStrategies = await getConfig("top_20_strategies") || "";
    const externalContactRequired = await getConfig("external_contact_approval_required");
    const restrictionExpiry = await getConfig("external_contact_restriction_expiry");
    const isRestrictionActive = externalContactRequired === "true" &&
      (!restrictionExpiry || new Date(restrictionExpiry) > new Date());

    // Load strategy insights from Mem0 memory for smarter task generation
    const strategyMemories = await searchMemories("winning strategy approach best performance scrap metal", {
      category: "strategy_insights",
      limit: 4,
    }).catch(() => []);
    const memoryContext = strategyMemories.length > 0
      ? `\n\nMEMORY INSIGHTS FROM PREVIOUS CYCLES:\n${strategyMemories.map(m => `- ${m.content}`).join('\n')}`
      : "";

    // Build goal context
    const goalsContext = activeGoals.map(g =>
      `Goal [ID:${g.id}] (priority ${g.priority}): ${g.goalText}\nSub-goals: ${JSON.stringify(g.subGoals || [])}`
    ).join("\n\n");

    const response = await invokeLLM({
      model,
      messages: [
        {
          role: "system",
          content: `You are an autonomous business operations AI.

OPERATING PRINCIPLES:
${constitution}

SAFETY RULES:
${safetyRules}

STRATEGIC CONTEXT:
${scrapStrategy}

TOP REVENUE STRATEGIES:
${topStrategies}

CURRENT RESTRICTIONS:
- External contact restriction active: ${isRestrictionActive ? "YES - all outbound calls/emails/SMS require approval" : "NO"}

TASK GENERATION RULES:
1. Generate EXACTLY ${generationCapacity} tasks maximum this cycle
2. Minimum ${Math.round(minInternalRatio * 100)}% must be INTERNAL tasks (web_research or data_entry - no external contact)
3. Phase 1 tasks (infrastructure, data building) take priority over Phase 2/3
4. Each task must include ROI score (1-10), phase (1/2/3), and whether it requires external contact
5. Tasks must have clear, specific actions — not vague goals
6. Include dependency info if the task requires something else to be done first
7. Avoid duplicating tasks already in the queue
8. Use memory insights below to generate smarter, higher-ROI tasks${memoryContext}
${privateCandidate ? `
PRIVATE CANDIDATE MODE:
- Generate only web_research tasks.
- Each task must be a contained research or analysis objective; do not claim it updates a workflow, record, document, or external system.
- Each task must be answerable now from current publicly accessible sources.
- Do not make private, proprietary, undisclosed, contact-required, or future data a required deliverable.
- When a useful scope may reveal an evidence gap, ask for an assessment of the available public evidence and a source-backed statement of what is unavailable, rather than requiring an unavailable metric.
- Do not generate data_entry, contact, payment, provider, or publication work.` : ""}

Respond in JSON format with an array of task objects.`
        },
        {
          role: "user",
          content: `Current active goals:\n${goalsContext}\n\nRecent tasks already in queue (AVOID DUPLICATING):\n- ${recentDescriptions || "None yet"}\n\nCurrent pending tasks in queue: ${pendingCount}\nQueue high-water mark: ${queueHighWaterMark}\n\nGenerate up to ${generationCapacity} new tasks. Prioritize Phase 1 internal tasks. Focus on what can be done RIGHT NOW without external contact.`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "task_list",
          strict: true,
          schema: {
            type: "object",
            properties: {
              tasks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    actionType: { type: "string" },
                    priorityScore: { type: "integer" },
                    estimatedValue: { type: "number" },
                    goalId: { type: "integer" },
                    roiScore: { type: "integer" },
                    phase: { type: "integer" },
                    requiresExternalContact: { type: "boolean" },
                    dependencies: { type: "array", items: { type: "string" } },
                    category: { type: "string" }
                  },
                  required: ["description", "actionType", "priorityScore", "estimatedValue", "goalId", "roiScore", "phase", "requiresExternalContact", "dependencies", "category"],
                  additionalProperties: false
                }
              }
            },
            required: ["tasks"],
            additionalProperties: false
          }
        }
      }
    });

    const content = response.choices[0]?.message?.content as string | null;
    if (!content) {
      return { tasksCreated: 0, error: "LLM returned empty response" };
    }

    const parsed = JSON.parse(content);
    let tasks = (parsed.tasks || []).slice(0, generationCapacity);

    // Enforce minimum internal ratio
    const internalTasks = tasks.filter((t: any) => !t.requiresExternalContact);
    const externalTasks = tasks.filter((t: any) => t.requiresExternalContact);
    const minInternal = Math.ceil(tasks.length * minInternalRatio);

    if (internalTasks.length < minInternal) {
      // Drop external tasks to meet ratio
      const allowedExternal = tasks.length - minInternal;
      tasks = [...internalTasks, ...externalTasks.slice(0, allowedExternal)];
    }

    const acceptedDescriptions: string[] = [];
    let duplicatesFiltered = 0;
    tasks = tasks.filter((task: any) => {
      const description =
        typeof task.description === "string" ? task.description.trim() : "";
      const overlapsExisting = recentTasks.some(existing =>
        taskDescriptionsOverlap(description, existing.description)
      );
      const overlapsBatch = acceptedDescriptions.some(existing =>
        taskDescriptionsOverlap(description, existing)
      );
      if (!description || overlapsExisting || overlapsBatch) {
        duplicatesFiltered++;
        return false;
      }
      acceptedDescriptions.push(description);
      task.description = description;
      return true;
    });

    let created = 0;
    const createdBatch: Array<{ id: number; description: string; dependencies: string[]; metadata: Record<string, unknown> }> = [];
    const validActionTypes = privateCandidate
      ? ["web_research"]
      : ["outbound_call", "send_email", "send_sms", "web_research", "data_entry"];

    for (const task of tasks) {
      const actionType = validActionTypes.includes(task.actionType) ? task.actionType : "web_research";

      const metadata = {
        roiScore: task.roiScore,
        phase: task.phase,
        requiresExternalContact: task.requiresExternalContact,
        dependencies: task.dependencies || [],
        dag_dependencies: [],
        category: task.category,
        generated_at: new Date().toISOString(),
        generation_novelty_key: Array.from(
          new Set(taskDescriptionTokens(task.description))
        ).sort().join(" "),
        ...(privateCandidate
          ? {
              research_completion_contract_version:
                PRIVATE_RESEARCH_COMPLETION_CONTRACT_VERSION,
              public_evidence_only: true,
              evidence_gap_is_valid_completion: true,
            }
          : {}),
      };
      const persistedDescription = privateCandidate
        ? withPrivateResearchEvidenceContract(task.description)
        : task.description;
      // dag_dependencies stores numeric task IDs for DAG-aware execution
      // dependencies stores string labels for human readability
      const insertResult = await createTask({
        goalId: task.goalId,
        source: "task_generator",
        description: persistedDescription,
        priorityScore: Math.min(100, Math.max(1, task.priorityScore)),
        status: "pending",
        assignedAgent: "autonomous_worker",
        actionType,
        estimatedValue: String(task.estimatedValue || 0),
        metadata,
      });
      if (!insertResult) {
        throw new Error("Task insert did not return a database result");
      }
      const insertId = Number((insertResult as any)?.[0]?.insertId ?? (insertResult as any)?.insertId);
      if (!Number.isInteger(insertId) || insertId <= 0) {
        throw new Error("Task insert did not return a valid task ID");
      }
      created++;
      createdBatch.push({ id: insertId, description: task.description, dependencies: task.dependencies || [], metadata });

    // Link dependencies within this batch (Part A of DAG resolution)
    if (createdBatch.length > 0 && createdBatch.length === tasks.length) {
      try {
        const batchTasks = createdBatch.map(t => ({
          id: t.id,
          description: t.description,
          dependencies: t.dependencies,
        }));
        const resolutions = await linkBatchDependencies(batchTasks);
        for (const resolution of resolutions) {
          const task = createdBatch.find(entry => entry.id === resolution.taskId);
          if (task) {
            await updateTask(task.id, {
              metadata: { ...task.metadata, dag_dependencies: resolution.dependsOn },
            });
          }
        }
        if (resolutions.length > 0) {
          console.log(`[Task Generator] Linked ${resolutions.length} batch dependencies`);
        }
      } catch (error) {
        console.warn("[Task Generator] Error linking batch dependencies:", error);
      }
    }
    }

    // Log the execution
    await logExecution({
      actionType: "task_generation",
      details: {
        tasksCreated: created,
        model,
        goalsProcessed: activeGoals.length,
        pendingBefore: pendingCount,
        queueHighWaterMark,
        generationCapacity,
        duplicatesFiltered,
        internalCount: tasks.filter((t: any) => !t.requiresExternalContact).length,
        externalCount: tasks.filter((t: any) => t.requiresExternalContact).length,
      },
      outcome: "success",
      tokensCost: response.usage?.total_tokens || 0,
    });

    return { tasksCreated: created };
  } catch (error: any) {
    const isUsageExhausted = error.message?.includes("LLM_USAGE_EXHAUSTED");
    if (isUsageExhausted) {
      console.warn("[TaskGenerator] Skipping cycle — Manus Forge LLM quota exhausted. Will retry next cycle.");
      return { tasksCreated: 0, error: "LLM quota exhausted — skipping cycle" };
    }
    await logExecution({
      actionType: "task_generation",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { tasksCreated: 0, error: error.message };
  }
}
