import { invokeLLM } from "../_core/llm";
import {
  getCompletedTasksSince, createEvaluation, logExecution,
  getConfig, isKillSwitchActive, upsertDailyMetrics, updateTask
} from "../db";
import { notifyOwner } from "../_core/notification";
import { verifyTaskOutcome } from "./verifier";

/**
 * Evaluator — runs daily at 6pm AWST (10:00 UTC).
 *
 * Upgraded with dual-agent verification:
 * 1. First pass: independent LLM-as-Judge verifies each completed task
 * 2. Second pass: evaluator LLM assesses lessons learned and improvement suggestions
 * 3. Tasks that fail verification are flagged and logged for human review
 * 4. Daily summary includes verification scores alongside evaluation scores
 */
export async function runEvaluator(): Promise<{ evaluated: number; error?: string }> {
  try {
    if (await isKillSwitchActive()) {
      return { evaluated: 0, error: "Kill switch is active" };
    }

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

    let evaluated = 0;
    let verificationPassed = 0;
    let verificationFailed = 0;
    const summaries: string[] = [];
    const flaggedForReview: string[] = [];

    for (const task of completedTasks) {
      // ── Step 1: Dual-agent verification (independent LLM-as-Judge) ──────────
      // Check if this task was already verified during execution
      const existingMeta = (task.metadata as Record<string, unknown>) || {};
      let verificationResult = existingMeta.verification_result as {
        verified: boolean;
        score: number;
        verdict: string;
        reasoning: string;
        recommendedAction: string;
        unintendedSideEffects: string[];
      } | null;

      if (!verificationResult) {
        // Run verification now if it wasn't done during execution
        const vr = await verifyTaskOutcome({
          id: task.id,
          description: task.description,
          actionType: task.actionType,
          resultSummary: task.resultSummary,
          metadata: task.metadata,
        });
        verificationResult = vr;

        // Store verification result back on the task
        await updateTask(task.id, {
          metadata: {
            ...existingMeta,
            verification_result: {
              verified: vr.verified,
              score: vr.score,
              verdict: vr.verdict,
              reasoning: vr.reasoning,
              recommendedAction: vr.recommendedAction,
              unintendedSideEffects: vr.unintendedSideEffects,
            },
          },
        });
      }

      if (verificationResult.verified) {
        verificationPassed++;
      } else {
        verificationFailed++;
        flaggedForReview.push(`Task #${task.id}: ${task.description.substring(0, 60)} — ${verificationResult.reasoning}`);
      }

      // ── Step 2: Evaluation LLM (lessons learned, improvement suggestions) ───
      const response = await invokeLLM({
        model,
        messages: [
          {
            role: "system",
            content: `You are evaluating the outcome of an autonomous business task for Robur Resources (resource recovery company, Perth WA). You have access to an independent verification result. Assess what was learned and what could be improved. Be specific and actionable.`,
          },
          {
            role: "user",
            content: `Task: ${task.description}
Action Type: ${task.actionType}
Result: ${task.resultSummary || "No result recorded"}

Independent Verification:
- Verified: ${verificationResult.verified}
- Score: ${(verificationResult.score * 100).toFixed(0)}%
- Verdict: ${verificationResult.verdict}
- Reasoning: ${verificationResult.reasoning}
- Unintended Side Effects: ${verificationResult.unintendedSideEffects?.join(", ") || "None"}
- Recommended Action: ${verificationResult.recommendedAction}

Evaluate this task's outcome and provide lessons learned.`,
          },
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
                briefSummary: { type: "string" },
              },
              required: ["success", "lessonLearned", "strategyUsed", "improvementSuggestion", "briefSummary"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content as string;
      if (content) {
        const evalData = JSON.parse(content);
        const successValue = (["true", "false", "partial"].includes(evalData.success)
          ? evalData.success
          : "partial") as "true" | "false" | "partial";

        await createEvaluation({
          taskId: task.id,
          success: successValue,
          lessonLearned: evalData.lessonLearned,
          strategyUsed: evalData.strategyUsed,
          improvementSuggestion: evalData.improvementSuggestion,
        });

        const verifyIcon = verificationResult.verified ? "✓" : "✗";
        summaries.push(
          `${verifyIcon} ${task.description.substring(0, 60)}: ${evalData.briefSummary} (verify score: ${(verificationResult.score * 100).toFixed(0)}%)`
        );
        evaluated++;
      }
    }

    // Generate daily summary with verification stats
    const verificationRate = completedTasks.length > 0
      ? ((verificationPassed / completedTasks.length) * 100).toFixed(0)
      : "0";

    const dailySummary = [
      `Daily Evaluation (${new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Perth" })})`,
      `${completedTasks.length} tasks completed | ${verificationPassed} verified ✓ | ${verificationFailed} flagged ✗ | ${verificationRate}% verification rate`,
      "",
      summaries.join("\n"),
      flaggedForReview.length > 0 ? `\n⚠️ Flagged for review:\n${flaggedForReview.join("\n")}` : "",
    ].filter(Boolean).join("\n");

    // Update daily metrics
    const today = new Date().toISOString().split("T")[0];
    const successRate = completedTasks.length > 0
      ? (verificationPassed / completedTasks.length).toFixed(4)
      : "0";
    await upsertDailyMetrics(today, { successRate });

    // Notify owner
    await notifyOwner({
      title: `Daily Evaluation — ${evaluated} tasks reviewed, ${verificationRate}% verified`,
      content: dailySummary,
    });

    await logExecution({
      actionType: "evaluation",
      details: {
        evaluated,
        verificationPassed,
        verificationFailed,
        verificationRate: `${verificationRate}%`,
        summary: dailySummary.substring(0, 500),
      },
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
