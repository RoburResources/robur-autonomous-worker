import { invokeLLM } from "../_core/llm";
import {
  getCompletedTasksSince, createEvaluation, logExecution,
  getConfig, getRecentEvaluations, upsertDailyMetrics
} from "../db";
import { makeBriefingCall } from "../integrations/retell";
import { notifyOwner } from "../_core/notification";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

/**
 * Evaluator — runs daily at 6pm AWST (10:00 UTC)
 * Reviews completed tasks, assesses outcomes, logs metrics,
 * generates daily summary, and triggers Addison evening briefing.
 */
export async function runEvaluator(): Promise<{ evaluated: number; error?: string }> {
  try {
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { evaluated: 0, error: gate.reason || "Legacy worker is unavailable" };
    }

    // Get tasks completed in the last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const completedTasks = await getCompletedTasksSince(since);

    if (completedTasks.length === 0) {
      await logExecution({
        actionType: "evaluation",
        details: { message: "No completed tasks to evaluate" },
        outcome: "success",
      });
      return { evaluated: 0 };
    }

    const model = (await getConfig("evaluation_model")) || "claude-sonnet-4-6";

    // Evaluate each task
    let evaluated = 0;
    const summaries: string[] = [];

    for (const task of completedTasks) {
      const response = await invokeLLM({
        model,
        messages: [
          {
            role: "system",
            content: `You are evaluating the outcome of an autonomous business task. Assess whether the task was truly successful, what was learned, and what could be improved.`
          },
          {
            role: "user",
            content: `Task: ${task.description}\nAction Type: ${task.actionType}\nResult: ${task.resultSummary || "No result recorded"}\n\nEvaluate this task's success and provide lessons learned.`
          }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "evaluation",
            strict: true,
            schema: {
              type: "object",
              properties: {
                success: { type: "string", description: "true, false, or partial" },
                lessonLearned: { type: "string" },
                strategyUsed: { type: "string" },
                improvementSuggestion: { type: "string" },
                briefSummary: { type: "string" }
              },
              required: ["success", "lessonLearned", "strategyUsed", "improvementSuggestion", "briefSummary"],
              additionalProperties: false
            }
          }
        }
      });

      const content = response.choices[0]?.message?.content as string;
      if (content) {
        const evalData = JSON.parse(content);
        const successValue = (["true", "false", "partial"].includes(evalData.success) ? evalData.success : "partial") as "true" | "false" | "partial";

        await createEvaluation({
          taskId: task.id,
          success: successValue,
          lessonLearned: evalData.lessonLearned,
          strategyUsed: evalData.strategyUsed,
          improvementSuggestion: evalData.improvementSuggestion,
        });

        summaries.push(`- ${task.description}: ${evalData.briefSummary}`);
        evaluated++;
      }
    }

    // Generate daily summary
    const dailySummary = `Daily Summary (${new Date().toLocaleDateString("en-AU")}):\n${completedTasks.length} tasks completed today.\n\n${summaries.join("\n")}`;

    // Update daily metrics
    const today = new Date().toISOString().split("T")[0];
    const successCount = completedTasks.filter(t => t.resultSummary && !t.resultSummary.includes("failed")).length;
    const successRate = completedTasks.length > 0 ? (successCount / completedTasks.length).toFixed(4) : "0";
    await upsertDailyMetrics(today, { successRate });

    // Notify owner
    await notifyOwner({
      title: `Daily Evaluation Complete - ${evaluated} tasks reviewed`,
      content: dailySummary,
    });

    // Log evaluation run
    await logExecution({
      actionType: "evaluation",
      details: { evaluated, summary: dailySummary.substring(0, 500) },
      outcome: "success",
    });

    return { evaluated };
  } catch (error: any) {
    await logExecution({
      actionType: "evaluation",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { evaluated: 0, error: error.message };
  }
}
