import { invokeLLM } from "../_core/llm";

export interface CanaryResult {
  passed: boolean;
  syntheticOutput: string;
  issues: string[];
  recommendation: "proceed" | "abort" | "modify";
  modificationSuggestion?: string;
}

/**
 * Canary Execution Engine
 *
 * Before running a task against production data or real external contacts,
 * runs it in a sandbox against synthetic data and verifies the output.
 * Only if the canary passes does it execute against real targets.
 *
 * This is applied to external-contact tasks (outbound_call, send_email, send_sms)
 * where mistakes have real-world consequences that are hard to reverse.
 *
 * The canary uses the same LLM prompt as the real execution but substitutes
 * synthetic data (fake names, numbers, companies) to test the logic without
 * side effects.
 */
export async function runCanaryExecution(task: {
  id: number;
  description: string;
  actionType?: string | null;
  actionPayload?: unknown;
}): Promise<CanaryResult> {
  // Only run canary for external-contact actions
  const externalActions = ["outbound_call", "send_email", "send_sms"];
  if (!task.actionType || !externalActions.includes(task.actionType)) {
    return {
      passed: true,
      syntheticOutput: "Canary not required for this action type",
      issues: [],
      recommendation: "proceed",
    };
  }

  try {
    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are running a CANARY TEST — a dry run of a business task using SYNTHETIC DATA only. No real people, real phone numbers, or real email addresses should appear in the output. Replace all real contact details with clearly fake placeholders like [SYNTHETIC_CONTACT], [TEST_PHONE], [TEST_EMAIL].

Your job is to:
1. Simulate what the task would produce using synthetic data
2. Check whether the output would be appropriate, professional, and achieve the task goal
3. Identify any issues that would cause the real execution to fail or produce inappropriate output
4. Recommend whether to proceed, abort, or modify the task`,
        },
        {
          role: "user",
          content: `Run a canary test for this task:

Task: ${task.description}
Action Type: ${task.actionType}
Payload: ${JSON.stringify(task.actionPayload || {})}

Simulate the output using synthetic data and assess whether the real execution should proceed.`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "canary_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              passed: { type: "boolean", description: "True if the canary test passed and real execution should proceed" },
              syntheticOutput: { type: "string", description: "The simulated output using synthetic data" },
              issues: {
                type: "array",
                items: { type: "string" },
                description: "Issues found during canary testing",
              },
              recommendation: {
                type: "string",
                enum: ["proceed", "abort", "modify"],
                description: "Whether to proceed with real execution, abort, or modify the task first",
              },
              modificationSuggestion: {
                type: "string",
                description: "If recommendation is modify, what should be changed",
              },
            },
            required: ["passed", "syntheticOutput", "issues", "recommendation"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response.choices[0]?.message?.content as string;
    if (!content) {
      return {
        passed: false,
        syntheticOutput: "",
        issues: ["Canary LLM call returned no content"],
        recommendation: "abort",
      };
    }

    return JSON.parse(content) as CanaryResult;
  } catch (error: any) {
    return {
      passed: false,
      syntheticOutput: "",
      issues: [`Canary execution failed: ${error.message}`],
      recommendation: "abort",
    };
  }
}
