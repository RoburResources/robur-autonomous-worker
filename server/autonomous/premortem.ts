import { invokeLLM } from "../_core/llm";
import { getConfig } from "../db";

export interface PremortemResult {
  confidenceScore: number;       // 0.0 – 1.0
  failureModes: FailureMode[];
  shouldEscalate: boolean;       // true if confidence < CONFIDENCE_THRESHOLD
  escalationReason?: string;
}

export interface FailureMode {
  risk: string;
  likelihood: "low" | "medium" | "high";
  mitigation: string;
  isBlocker: boolean;
}

const CONFIDENCE_THRESHOLD = 0.85;

/**
 * Pre-mortem engine — runs before every task execution.
 *
 * Asks the LLM: "What are the top 3 ways this task could fail?"
 * Returns a confidence score and failure modes. Tasks below 0.85
 * confidence are auto-escalated to human review via SMS.
 */
export async function runPremortem(task: {
  id: number;
  description: string;
  actionType?: string | null;
  metadata?: unknown;
}): Promise<PremortemResult> {
  try {
    const constitution = await getConfig("agent_constitution") || "";
    const actionType = task.actionType || "unknown";

    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `You are a pre-mortem risk analyst for an autonomous AI business agent. Your job is to identify failure modes BEFORE a task executes so they can be mitigated or the task escalated to human review.

${constitution ? `Agent Constitution:\n${constitution.substring(0, 500)}\n\n` : ""}Assess the task honestly. Be specific about risks — generic answers like "it might fail" are not useful. Focus on concrete, actionable failure modes.`,
        },
        {
          role: "user",
          content: `Analyse this task before execution:\n\nTask: ${task.description}\nAction Type: ${actionType}\n\nIdentify the top 3 most likely failure modes. For each, assess likelihood, provide a mitigation, and flag if it is a hard blocker. Then provide an overall confidence score (0.0–1.0) for successful execution.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "premortem_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              confidenceScore: {
                type: "number",
                description: "Overall confidence that this task will succeed (0.0 = certain failure, 1.0 = certain success)",
              },
              failureModes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    risk: { type: "string" },
                    likelihood: { type: "string", enum: ["low", "medium", "high"] },
                    mitigation: { type: "string" },
                    isBlocker: { type: "boolean" },
                  },
                  required: ["risk", "likelihood", "mitigation", "isBlocker"],
                  additionalProperties: false,
                },
              },
            },
            required: ["confidenceScore", "failureModes"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content as string;
    if (!content) {
      // If LLM fails, default to low confidence to force escalation
      return {
        confidenceScore: 0.5,
        failureModes: [{ risk: "Pre-mortem LLM call failed", likelihood: "high", mitigation: "Manual review required", isBlocker: false }],
        shouldEscalate: true,
        escalationReason: "Pre-mortem analysis unavailable — defaulting to human review",
      };
    }

    const parsed = JSON.parse(content) as { confidenceScore: number; failureModes: FailureMode[] };

    // Clamp confidence to valid range
    const confidenceScore = Math.max(0, Math.min(1, parsed.confidenceScore));
    const failureModes = parsed.failureModes || [];

    // Check for hard blockers
    const hardBlockers = failureModes.filter(f => f.isBlocker && f.likelihood !== "low");
    const hasHardBlocker = hardBlockers.length > 0;

    const shouldEscalate = confidenceScore < CONFIDENCE_THRESHOLD || hasHardBlocker;
    let escalationReason: string | undefined;

    if (hasHardBlocker) {
      escalationReason = `Hard blocker identified: ${hardBlockers[0].risk}`;
    } else if (confidenceScore < CONFIDENCE_THRESHOLD) {
      escalationReason = `Confidence score ${(confidenceScore * 100).toFixed(0)}% is below the ${(CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold`;
    }

    return { confidenceScore, failureModes, shouldEscalate, escalationReason };
  } catch (error: any) {
    // On error, escalate to be safe
    return {
      confidenceScore: 0.5,
      failureModes: [{ risk: `Pre-mortem error: ${error.message}`, likelihood: "high", mitigation: "Manual review required", isBlocker: false }],
      shouldEscalate: true,
      escalationReason: `Pre-mortem analysis failed: ${error.message}`,
    };
  }
}
