import { invokeLLM } from "../_core/llm";
import { getActiveGoals, createTask, getConfig, isKillSwitchActive, getRecentTasks, logExecution } from "../db";

/**
 * Task Generator — runs hourly
 * Queries active goals, decomposes them into prioritized tasks using LLM,
 * and adds new tasks to the queue.
 */
export async function runTaskGenerator(): Promise<{ tasksCreated: number; error?: string }> {
  try {
    // Safety check
    if (await isKillSwitchActive()) {
      return { tasksCreated: 0, error: "Kill switch is active" };
    }

    const activeGoals = await getActiveGoals();
    if (activeGoals.length === 0) {
      return { tasksCreated: 0, error: "No active goals" };
    }

    // Get recent tasks to avoid duplication
    const recentTasks = await getRecentTasks(50);
    const recentDescriptions = recentTasks.map(t => t.description).join("\n- ");

    const model = (await getConfig("task_generation_model")) || "gpt-5-mini";

    // Build goal context
    const goalsContext = activeGoals.map(g => 
      `Goal (priority ${g.priority}): ${g.goalText}\nSub-goals: ${JSON.stringify(g.subGoals || [])}`
    ).join("\n\n");

    const response = await invokeLLM({
      model,
      messages: [
        {
          role: "system",
          content: `You are an autonomous business operations AI for Robur Resources, a scrap metal collection and recycling company in Perth, Western Australia.

Your job is to generate specific, actionable tasks that advance the company's goals. Each task should be executable by an AI agent with access to: phone calls (via Addison voice agent), email, SMS, and web research.

Key customers (supply scrap): Pinwreck, Zenon Recycle, Owens for Scrap, Shine Auto Parts
Key buyers (sell to): Allied Metal, CD Dodds, Sims Metal
Location: Perth, Western Australia

Generate 3-5 NEW tasks. Each task must have:
- description: A clear, specific action (not vague)
- actionType: one of "outbound_call", "send_email", "send_sms", "web_research", "data_entry"
- priorityScore: 1-100 (higher = more urgent/valuable)
- estimatedValue: estimated dollar value if successful (0 if not applicable)
- goalId: which goal this advances (use the goal ID number)

Respond in JSON format with an array of task objects.`
        },
        {
          role: "user",
          content: `Current active goals:\n${goalsContext}\n\nRecent tasks already in queue (avoid duplicates):\n- ${recentDescriptions || "None yet"}\n\nGenerate new tasks to advance these goals. Focus on high-impact actions that can be executed today.`
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
                    goalId: { type: "integer" }
                  },
                  required: ["description", "actionType", "priorityScore", "estimatedValue", "goalId"],
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
    const tasks = parsed.tasks || [];
    let created = 0;

    for (const task of tasks) {
      const validActionTypes = ["outbound_call", "send_email", "send_sms", "web_research", "data_entry"];
      const actionType = validActionTypes.includes(task.actionType) ? task.actionType : "web_research";
      
      await createTask({
        goalId: task.goalId,
        source: "task_generator",
        description: task.description,
        priorityScore: Math.min(100, Math.max(1, task.priorityScore)),
        status: "pending",
        assignedAgent: "autonomous_worker",
        actionType,
        estimatedValue: String(task.estimatedValue || 0),
      });
      created++;
    }

    // Log the execution
    await logExecution({
      actionType: "task_generation",
      details: { tasksCreated: created, model, goalsProcessed: activeGoals.length },
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
