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

// Thresholds by action type — internal tasks have lower escalation bar
const CONFIDENCE_THRESHOLDS: Record<string, number> = {
  web_research: 0.60,    // Research tasks are low-risk — only escalate if truly blocked
  data_entry: 0.65,      // Data entry is low-risk
  send_email: 0.80,      // External contact — higher bar
  send_sms: 0.80,        // External contact — higher bar
  outbound_call: 0.85,   // Calls are highest risk — strict threshold
};
const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Pre-mortem engine — runs before every task execution.
 *
 * Asks the LLM: "What are the top 3 ways this task could fail?"
 * Returns a confidence score and failure modes. Tasks below threshold
 * confidence are auto-escalated to human review via SMS.
 *
 * Hard blockers only escalate for EXTERNAL CONTACT tasks.
 * Internal tasks (web_research, data_entry) proceed unless confidence is very low.
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
    const isExternalContact = ["outbound_call", "send_email", "send_sms"].includes(actionType);
    const confidenceThreshold = CONFIDENCE_THRESHOLDS[actionType] ?? DEFAULT_CONFIDENCE_THRESHOLD;

    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a pre-mortem risk analyst for an autonomous AI business agent. Your job is to identify failure modes BEFORE a task executes.

${constitution ? `Agent Constitution:\n${constitution.substring(0, 500)}\n\n` : ""}IMPORTANT CALIBRATION:
- For INTERNAL tasks (web_research, data_entry): Only mark isBlocker=true if the task is LITERALLY IMPOSSIBLE to attempt (e.g., required file doesn't exist, URL is invalid). Data quality concerns, incomplete results, or partial success are NOT blockers — the agent can still attempt the task and produce partial value.
- For EXTERNAL CONTACT tasks (outbound_call, send_email, send_sms): Mark isBlocker=true if the action would cause real-world harm, violate compliance, or has a critical missing prerequisite (e.g., no phone number, no email address).
- Be realistic about confidence: a web_research task should score 0.85+ unless there is a genuine technical blocker.

Assess the task honestly. Be specific about risks.`,
        },
        {
          role: "user",
          content: `Analyse this task before execution:\n\nTask: ${task.description}\nAction Type: ${actionType}\n\nIdentify the top 3 most likely failure modes. For each, assess likelihood, provide a mitigation, and flag if it is a hard blocker (see calibration rules above). Then provide an overall confidence score (0.0–1.0) for successful execution.`,
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

    // Hard blockers only trigger escalation for external contact tasks
    // Internal tasks (web_research, data_entry) proceed unless confidence is very low
    const hardBlockers = failureModes.filter(f => f.isBlocker && f.likelihood === "high");
    const hasHardBlocker = isExternalContact && hardBlockers.length > 0;

    const shouldEscalate = confidenceScore < confidenceThreshold || hasHardBlocker;
    let escalationReason: string | undefined;

    if (hasHardBlocker) {
      escalationReason = `Hard blocker identified: ${hardBlockers[0].risk}`;
    } else if (confidenceScore < confidenceThreshold) {
      escalationReason = `Confidence score ${(confidenceScore * 100).toFixed(0)}% is below the ${(confidenceThreshold * 100).toFixed(0)}% threshold for ${actionType}`;
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
