/**
 * Output Schema Validator
 *
 * Defines JSON schema contracts for each action type and validates
 * task outputs against them before marking a task as completed.
 *
 * This implements the "formal output schema validation" principle:
 * if the output doesn't match the schema, the task is marked failed
 * regardless of what the LLM thinks.
 */

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Output Schemas Per Action Type ─────────────────────────────────────────

const OUTPUT_SCHEMAS: Record<string, OutputSchema> = {
  web_research: {
    required: ["findings"],
    minLength: { findings: 50 },
    forbidden: ["I cannot", "I don't have access", "As an AI"],
  },
  data_entry: {
    required: ["result"],
    minLength: { result: 10 },
    forbidden: [],
  },
  outbound_call: {
    required: ["callId"],
    minLength: {},
    forbidden: [],
  },
  send_email: {
    required: ["body"],
    minLength: { body: 50 },
    forbidden: [],
  },
  send_sms: {
    required: ["message"],
    minLength: { message: 5 },
    forbidden: [],
  },
};

interface OutputSchema {
  required: string[];
  minLength: Record<string, number>;
  forbidden: string[];
}

function labeledFieldValue(
  resultSummary: string,
  field: string
): string | null {
  const labelPattern = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]*");
  const marker = new RegExp(`\\b${labelPattern}\\s*:\\s*`, "i").exec(
    resultSummary
  );
  if (!marker) return null;

  const remainder = resultSummary.slice(marker.index + marker[0].length);
  const candidateEnds = [
    remainder.indexOf(" | "),
    remainder.search(/\n\s*[A-Za-z][A-Za-z0-9 _-]{0,30}:\s*/),
  ].filter(index => index >= 0);
  const end =
    candidateEnds.length > 0 ? Math.min(...candidateEnds) : remainder.length;
  const value = remainder.slice(0, end).trim();
  return value || null;
}

/**
 * Validate a task's result summary against the expected output schema
 * for its action type.
 */
export function validateTaskOutput(
  actionType: string,
  resultSummary: string | null | undefined
): SchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!resultSummary || resultSummary.trim().length === 0) {
    return {
      valid: false,
      errors: ["Result summary is empty — task produced no output"],
      warnings: [],
    };
  }

  const schema = OUTPUT_SCHEMAS[actionType];
  if (!schema) {
    // An explicit unknown contract must never inherit a permissive fallback.
    return {
      valid: false,
      errors: [`No output schema defined for action type: ${actionType}`],
      warnings,
    };
  }

  // Check forbidden phrases (hallucination indicators)
  for (const phrase of schema.forbidden) {
    if (resultSummary.toLowerCase().includes(phrase.toLowerCase())) {
      errors.push(`Output contains forbidden phrase indicating failure: "${phrase}"`);
    }
  }

  // Required labels bind the prose result to the action-specific contract.
  for (const field of schema.required) {
    if (labeledFieldValue(resultSummary, field) === null) {
      errors.push(`Output is missing required field: ${field}`);
    }
  }

  // Check minimum length requirements on the actual labeled field value.
  for (const [field, minLen] of Object.entries(schema.minLength)) {
    const fieldValue = labeledFieldValue(resultSummary, field);
    if (fieldValue !== null && fieldValue.length < minLen) {
      errors.push(
        `Output too short: expected at least ${minLen} characters for ${field}, got ${fieldValue.length}`
      );
    }
  }

  if (actionType === "web_research") {
    const sourceSection = resultSummary.match(/(?:^|\n)Sources:\s*\n([\s\S]*)$/i);
    const urls = new Set(
      Array.from(
        (sourceSection?.[1] || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g),
        match => match[0].replace(/[.,;:]+$/, "")
      )
    );
    if (!sourceSection) {
      errors.push("Web research output is missing a visible Sources section");
    } else if (urls.size < 2) {
      errors.push(
        `Web research output cites ${urls.size} distinct source(s); at least 2 are required`
      );
    }
  }

  // Check for error indicators in the summary
  const errorIndicators = [
    "failed:", "error:", "exception:", "could not", "unable to",
    "timeout", "rate limit", "403", "404", "500",
  ];
  for (const indicator of errorIndicators) {
    if (resultSummary.toLowerCase().startsWith(indicator)) {
      errors.push(`Output starts with error indicator: "${indicator}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a task's input (description + metadata) before execution.
 * Ensures the task has the minimum data needed to attempt execution.
 */
export function validateTaskInput(task: {
  description: string;
  actionType?: string | null;
  actionPayload?: unknown;
  metadata?: unknown;
}): SchemaValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!task.description || task.description.trim().length < 10) {
    errors.push("Task description is too short or missing (minimum 10 characters)");
  }

  if (!task.actionType) {
    warnings.push("No action type specified — will default to web_research");
  }

  const validActionTypes = ["outbound_call", "send_email", "send_sms", "web_research", "data_entry"];
  if (task.actionType && !validActionTypes.includes(task.actionType)) {
    errors.push(`Unknown action type: ${task.actionType}`);
  }

  // Action-specific input validation
  if (task.actionType === "outbound_call") {
    const payload = task.actionPayload as Record<string, unknown> | null;
    if (!payload?.phoneNumber) {
      warnings.push("No target phone number in actionPayload — will use default (user phone)");
    }
  }

  if (task.actionType === "send_email") {
    const payload = task.actionPayload as Record<string, unknown> | null;
    if (!payload?.email) {
      warnings.push("No target email address in actionPayload — email will be drafted only");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
