import { invokeLLM } from "../_core/llm";

export interface VerificationResult {
  verified: boolean;
  score: number;           // 0.0 – 1.0
  verdict: "pass" | "fail" | "partial";
  reasoning: string;
  unintendedSideEffects: string[];
  recommendedAction: "accept" | "retry" | "escalate" | "rollback";
}

const MINIMUM_ACCEPTED_SCORE = 0.8;

export function reconcileVerificationResult(
  result: VerificationResult
): VerificationResult {
  const score = Math.max(0, Math.min(1, result.score));
  const verified =
    result.verified === true &&
    result.verdict === "pass" &&
    result.recommendedAction === "accept" &&
    result.unintendedSideEffects.length === 0 &&
    score >= MINIMUM_ACCEPTED_SCORE;

  return {
    ...result,
    score,
    verified,
  };
}

/**
 * Dual-agent verifier — runs AFTER task execution.
 *
 * Uses the service's supported model to verify whether the task actually
 * achieved its goal and whether any unintended side effects occurred.
 *
 * This is the LLM-as-Judge pattern: a second model that did NOT
 * participate in execution reviews the outcome objectively.
 */
export async function verifyTaskOutcome(task: {
  id: number;
  description: string;
  actionType?: string | null;
  resultSummary?: string | null;
  metadata?: unknown;
}): Promise<VerificationResult> {
  try {
    const response = await invokeLLM({
      // The private candidate has a verified gpt-4o-mini path. Do not select
      // an unconfigured provider model here: an unavailable verifier must not
      // turn otherwise successful internal work into a false failure.
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an independent verification agent. Your ONLY job is to objectively assess whether a completed task actually achieved its stated goal. You did NOT participate in planning or executing this task. Be critical and precise.

Assess:
1. Did the result match the task's stated objective?
2. Was the result complete or only partial?
3. Were there any unintended side effects or risks introduced?
4. What should happen next (accept, retry, escalate to human, or rollback)?

Score 1.0 = perfect success, 0.0 = complete failure.

Keep the fields internally consistent:
- verified=true requires verdict=pass, recommendedAction=accept, no unintended side effects, and score at least 0.8.
- verdict=partial or recommendedAction=retry means verified=false.
- For a research task, judge the scope actually requested rather than imposing an impossible exhaustive or statistically representative standard.
- A complete analysis of accessible public evidence can pass when it answers the objective, supports material claims with citations, distinguishes direct evidence from inference, and clearly states limitations or unavailable data.
- Do not penalize honest caveats or require private submissions, undisclosed records, outside contact, or statistically representative sentiment unless the task explicitly requires them.
- Recommend retry only when the result omits reasonably discoverable evidence or fails to answer the stated task, not merely because additional evidence could improve confidence.
- A comprehensive source-backed finding that requested information is not publicly disclosed can still be a complete pass when the limitation is explicit.`,
        },
        {
          role: "user",
          content: `Verify this completed task:

Task Description: ${task.description}
Action Type: ${task.actionType || "unknown"}
Result Recorded: ${task.resultSummary || "No result recorded"}

Provide your independent verification verdict.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verification_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              verified: { type: "boolean", description: "True if the task genuinely succeeded" },
              score: { type: "number", description: "0.0 to 1.0 success score" },
              verdict: { type: "string", enum: ["pass", "fail", "partial"] },
              reasoning: { type: "string", description: "Concise explanation of the verdict" },
              unintendedSideEffects: {
                type: "array",
                items: { type: "string" },
                description: "Any unintended consequences or risks introduced by this action",
              },
              recommendedAction: {
                type: "string",
                enum: ["accept", "retry", "escalate", "rollback"],
                description: "What should happen next based on this verification",
              },
            },
            required: ["verified", "score", "verdict", "reasoning", "unintendedSideEffects", "recommendedAction"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content as string;
    if (!content) {
      return {
        verified: false,
        score: 0,
        verdict: "fail",
        reasoning: "Verification LLM call returned no content",
        unintendedSideEffects: [],
        recommendedAction: "escalate",
      };
    }

    const parsed = JSON.parse(content) as VerificationResult;

    return reconcileVerificationResult(parsed);
  } catch (error: any) {
    return {
      verified: false,
      score: 0,
      verdict: "fail",
      reasoning: `Verification failed: ${error.message}`,
      unintendedSideEffects: [],
      recommendedAction: "escalate",
    };
  }
}
