import { invokeLLM } from "../_core/llm";
import { getActiveGoals, createTask, getConfig, getAllConfig, getRecentTasks, logExecution } from "../db";
import { linkBatchDependencies } from "./dependencyLinker";
import { searchMemories } from "../memory/mem0";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

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

    // Get recent tasks to avoid duplication
    const recentTasks = await getRecentTasks(100);
    const recentDescriptions = recentTasks.map(t => t.description).slice(0, 30).join("\n- ");
    const pendingCount = recentTasks.filter(t => t.status === "pending").length;

    // Don't over-generate — if queue already has many pending tasks, skip
    if (pendingCount >= 30) {
      return { tasksCreated: 0, error: `Queue already has ${pendingCount} pending tasks — skipping generation` };
    }

    const model = (await getConfig("task_generation_model")) || "gpt-5-mini";
    const maxTasksPerCycle = parseInt(await getConfig("max_tasks_per_generation_cycle") || "5");
    const minInternalRatio = parseFloat(await getConfig("min_internal_task_ratio") || "0.6");

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
1. Generate EXACTLY ${maxTasksPerCycle} tasks maximum per cycle
2. Minimum ${Math.round(minInternalRatio * 100)}% must be INTERNAL tasks (web_research or data_entry - no external contact)
3. Phase 1 tasks (infrastructure, data building) take priority over Phase 2/3
4. Each task must include ROI score (1-10), phase (1/2/3), and whether it requires external contact
5. Tasks must have clear, specific actions — not vague goals
6. Include dependency info if the task requires something else to be done first
7. Avoid duplicating tasks already in the queue
8. Use memory insights below to generate smarter, higher-ROI tasks${memoryContext}

Respond in JSON format with an array of task objects.`
        },
        {
          role: "user",
          content: `Current active goals:\n${goalsContext}\n\nRecent tasks already in queue (AVOID DUPLICATING):\n- ${recentDescriptions || "None yet"}\n\nCurrent pending tasks in queue: ${pendingCount}\n\nGenerate up to ${maxTasksPerCycle} new tasks. Prioritize Phase 1 internal tasks. Focus on what can be done RIGHT NOW without external contact.`
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
    let tasks = (parsed.tasks || []).slice(0, maxTasksPerCycle);

    // Enforce minimum internal ratio
    const internalTasks = tasks.filter((t: any) => !t.requiresExternalContact);
    const externalTasks = tasks.filter((t: any) => t.requiresExternalContact);
    const minInternal = Math.ceil(tasks.length * minInternalRatio);

    if (internalTasks.length < minInternal) {
      // Drop external tasks to meet ratio
      const allowedExternal = tasks.length - minInternal;
      tasks = [...internalTasks, ...externalTasks.slice(0, allowedExternal)];
    }

    let created = 0;
    const validActionTypes = ["outbound_call", "send_email", "send_sms", "web_research", "data_entry"];

    for (const task of tasks) {
      const actionType = validActionTypes.includes(task.actionType) ? task.actionType : "web_research";

      // dag_dependencies stores numeric task IDs for DAG-aware execution
      // dependencies stores string labels for human readability
      await createTask({
        goalId: task.goalId,
        source: "task_generator",
        description: task.description,
        priorityScore: Math.min(100, Math.max(1, task.priorityScore)),
        status: "pending",
        assignedAgent: "autonomous_worker",
        actionType,
        estimatedValue: String(task.estimatedValue || 0),
        metadata: JSON.stringify({
          roiScore: task.roiScore,
          phase: task.phase,
          requiresExternalContact: task.requiresExternalContact,
          dependencies: task.dependencies || [],
          dag_dependencies: [],  // numeric task IDs — populated when explicit task dependencies are known
          category: task.category,
          generated_at: new Date().toISOString(),
        }),
      });
      created++;

    // Link dependencies within this batch (Part A of DAG resolution)
    if (tasks.length > 0) {
      try {
        const batchTasks = tasks.map((t: any) => ({
          description: t.description,
          dependencies: t.dependencies || [],
        }));
        const resolutions = await linkBatchDependencies(batchTasks);
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
        internalCount: tasks.filter((t: any) => !t.requiresExternalContact).length,
        externalCount: tasks.filter((t: any) => t.requiresExternalContact).length,
      },
      outcome: "success",
      tokensCost: response.usage?.total_tokens || 0,
    });

    return { tasksCreated: created };
  } catch (error: any) {
    await logExecution({
      actionType: "task_generation",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { tasksCreated: 0, error: error.message };
  }
}
