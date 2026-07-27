import { invokeLLM } from "../_core/llm";
import { getRecentEvaluations, getConfig, setConfig, logExecution } from "../db";
import { notifyOwner } from "../_core/notification";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { getAllExperimentResults, seedInitialExperiments } from "./abTesting";
import { searchMemories, storeStrategyInsight } from "../memory/mem0";

/**
 * Self-Improver — runs weekly on Sunday
 * Analyzes evaluation data, identifies winning/losing strategies,
 * adjusts priority weights, and updates system approaches.
 */
export async function runSelfImprover(): Promise<{ improved: boolean; changes: string[]; error?: string }> {
  try {
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { improved: false, changes: [], error: gate.reason || "Legacy worker is unavailable" };
    }

    const recentEvals = await getRecentEvaluations(50);
    if (recentEvals.length < 5) {
      return { improved: false, changes: [], error: "Not enough evaluation data (need at least 5)" };
    }

    const model = (await getConfig("evaluation_model")) || "claude-sonnet-4-6";

    // Get current weights
    const callWeight = await getConfig("priority_weight_calls") || "1.2";
    const emailWeight = await getConfig("priority_weight_email") || "1.0";
    const researchWeight = await getConfig("priority_weight_research") || "0.8";

    // Analyze evaluation data
    // Seed initial A/B experiments if not already done
    await seedInitialExperiments().catch(() => {});

    // Get A/B testing results
    const abResults = await getAllExperimentResults().catch(() => []);
    const abSummary = abResults.map(r => ({
      experiment: r.experimentName,
      hasWinner: !!r.winner,
      winner: r.winner?.variantName,
      recommendation: r.recommendation,
      confidenceLevel: r.confidenceLevel,
    }));

    // Get strategy insights from Mem0 memory
    const strategyMemories = await searchMemories("winning strategy approach best performance", {
      category: "strategy_insights",
      limit: 5,
    }).catch(() => []);
    const memoryInsights = strategyMemories.map(m => m.content);

    const evalSummary = recentEvals.map(e => ({
      success: e.success,
      strategy: e.strategyUsed,
      lesson: e.lessonLearned,
      suggestion: e.improvementSuggestion,
    }));

    const response = await invokeLLM({
      model,
      messages: [
        {
          role: "system",
          content: `You are the self-improvement engine for an autonomous business AI. Analyze recent task evaluations, A/B test results, and memory insights to recommend strategy improvements.

Current priority weights:
- Outbound calls: ${callWeight}
- Email outreach: ${emailWeight}  
- Web research: ${researchWeight}

Recommend new weights (0.5 to 2.0 range) based on what's working.

A/B TEST RESULTS:
${abSummary.length > 0 ? JSON.stringify(abSummary, null, 2) : 'No experiments completed yet.'}

MEMORY INSIGHTS FROM PREVIOUS CYCLES:
${memoryInsights.length > 0 ? memoryInsights.join('\n') : 'No memory insights yet.'}`
        },
        {
          role: "user",
          content: `Recent evaluation data (${recentEvals.length} tasks):\n${JSON.stringify(evalSummary, null, 2)}\n\nAnalyze patterns, incorporate A/B test winners and memory insights, and recommend improvements.`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "improvements",
          strict: true,
          schema: {
            type: "object",
            properties: {
              newCallWeight: { type: "number" },
              newEmailWeight: { type: "number" },
              newResearchWeight: { type: "number" },
              keyInsights: { type: "array", items: { type: "string" } },
              strategicRecommendations: { type: "array", items: { type: "string" } },
              summary: { type: "string" }
            },
            required: ["newCallWeight", "newEmailWeight", "newResearchWeight", "keyInsights", "strategicRecommendations", "summary"],
            additionalProperties: false
          }
        }
      }
    });

    const content = response.choices[0]?.message?.content as string;
    if (!content) {
      return { improved: false, changes: [], error: "LLM returned empty response" };
    }

    const improvements = JSON.parse(content);
    const changes: string[] = [];

    // Apply weight adjustments (clamped to 0.5-2.0)
    const clamp = (v: number) => Math.max(0.5, Math.min(2.0, v));

    const newCallWeight = clamp(improvements.newCallWeight).toFixed(2);
    const newEmailWeight = clamp(improvements.newEmailWeight).toFixed(2);
    const newResearchWeight = clamp(improvements.newResearchWeight).toFixed(2);

    if (newCallWeight !== callWeight) {
      await setConfig("priority_weight_calls", newCallWeight);
      changes.push(`Call weight: ${callWeight} → ${newCallWeight}`);
    }
    if (newEmailWeight !== emailWeight) {
      await setConfig("priority_weight_email", newEmailWeight);
      changes.push(`Email weight: ${emailWeight} → ${newEmailWeight}`);
    }
    if (newResearchWeight !== researchWeight) {
      await setConfig("priority_weight_research", newResearchWeight);
      changes.push(`Research weight: ${researchWeight} → ${newResearchWeight}`);
    }

    // Store key insights in Mem0 for future cycles
    if (improvements.keyInsights && improvements.keyInsights.length > 0) {
      for (const insight of improvements.keyInsights.slice(0, 3)) {
        await storeStrategyInsight({
          insight,
          evidence: `Self-improver analysis of ${recentEvals.length} evaluations`,
          confidenceLevel: "medium",
        }).catch(() => {});
      }
    }

    // Log the improvement
    await logExecution({
      actionType: "self_improvement",
      details: {
        changes,
        insights: improvements.keyInsights,
        recommendations: improvements.strategicRecommendations,
        summary: improvements.summary,
      },
      outcome: "success",
    });

    // Notify owner of improvements
    await notifyOwner({
      title: "Weekly Self-Improvement Report",
      content: `${improvements.summary}\n\nChanges made:\n${changes.join("\n") || "No weight changes needed"}\n\nKey insights:\n${improvements.keyInsights.join("\n- ")}\n\nRecommendations:\n${improvements.strategicRecommendations.join("\n- ")}`,
    });

    return { improved: true, changes };
  } catch (error: any) {
    await logExecution({
      actionType: "self_improvement",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { improved: false, changes: [], error: error.message };
  }
}
