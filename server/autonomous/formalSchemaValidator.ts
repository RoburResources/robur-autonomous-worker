/**
 * Formal schema validator — validates structured outputs against strict JSON schema contracts.
 * Replaces heuristic validation with formal type checking.
 */

import { ACTION_SCHEMAS, ActionType, StructuredActionOutput } from "../../shared/actionTypes";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  confidence: number; // 0–1, how confident we are in this validation
}

/**
 * Validate a structured output against its action type's JSON schema.
 * Returns detailed validation result with confidence score.
 */
export function validateStructuredOutput(
  actionType: ActionType,
  output: StructuredActionOutput
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let confidence = 1.0;

  // Check if output has required fields
  if (!output.structured) {
    errors.push("Missing 'structured' field in output");
    return { valid: false, errors, warnings, confidence: 0 };
  }

  // Get the schema for this action type
  const schema = ACTION_SCHEMAS[actionType];
  if (!schema) {
    warnings.push(`No schema defined for action type: ${actionType}`);
    return { valid: true, errors, warnings, confidence: 0.5 };
  }

  // Validate against schema
  const schemaValidation = validateAgainstSchema(output.structured, schema);
  errors.push(...schemaValidation.errors);
  warnings.push(...schemaValidation.warnings);
  confidence = Math.max(0, Math.min(1, confidence - schemaValidation.errors.length * 0.2));

  // Action-specific validation rules
  const actionValidation = validateActionSpecific(actionType, output);
  errors.push(...actionValidation.errors);
  warnings.push(...actionValidation.warnings);
  confidence = Math.max(0, Math.min(1, confidence - actionValidation.errors.length * 0.15));

  // Check success flag consistency
  if (output.success && errors.length > 0) {
    warnings.push("Output marked as success but validation errors found");
    confidence *= 0.8;
  }

  if (!output.success && output.errorCode && !output.errorMessage) {
    warnings.push("Error code present but no error message");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

/**
 * Validate output against a JSON schema.
 */
function validateAgainstSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schemaProps = (schema.properties || {}) as Record<string, unknown>;
  const requiredFields = (schema.required || []) as string[];

  // Check required fields
  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate each field
  for (const [field, value] of Object.entries(data)) {
    const fieldSchema = schemaProps[field] as Record<string, unknown> | undefined;
    if (!fieldSchema) {
      warnings.push(`Unexpected field: ${field}`);
      continue;
    }

    // Type checking
    const expectedType = fieldSchema.type as string;
    const actualType = Array.isArray(value) ? "array" : typeof value;

    if (expectedType && actualType !== expectedType) {
      errors.push(`Field ${field}: expected ${expectedType}, got ${actualType}`);
      continue;
    }

    // Array validation
    if (expectedType === "array" && Array.isArray(value)) {
      const minItems = (fieldSchema.minItems as number) || 0;
      if (value.length < minItems) {
        errors.push(`Field ${field}: expected at least ${minItems} items, got ${value.length}`);
      }
    }

    // Number range validation
    if (expectedType === "number" && typeof value === "number") {
      const minimum = fieldSchema.minimum as number | undefined;
      const maximum = fieldSchema.maximum as number | undefined;

      if (minimum !== undefined && value < minimum) {
        errors.push(`Field ${field}: value ${value} is below minimum ${minimum}`);
      }
      if (maximum !== undefined && value > maximum) {
        errors.push(`Field ${field}: value ${value} is above maximum ${maximum}`);
      }
    }

    // String validation
    if (expectedType === "string" && typeof value === "string") {
      const minLength = (fieldSchema.minLength as number) || 0;
      if (value.length < minLength) {
        errors.push(`Field ${field}: string too short (${value.length} < ${minLength})`);
      }

      const pattern = fieldSchema.pattern as string | undefined;
      if (pattern && !new RegExp(pattern).test(value)) {
        errors.push(`Field ${field}: does not match pattern ${pattern}`);
      }
    }

    // Enum validation
    const enumValues = fieldSchema.enum as unknown[] | undefined;
    if (enumValues && !enumValues.includes(value)) {
      errors.push(`Field ${field}: value "${value}" not in allowed values: ${enumValues.join(", ")}`);
    }
  }

  return { errors, warnings };
}

/**
 * Action-specific validation rules beyond schema.
 */
function validateActionSpecific(
  actionType: ActionType,
  output: StructuredActionOutput
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  switch (actionType) {
    case "web_research": {
      const structured = output.structured as Record<string, unknown>;
      const findings = structured.findings as string[] | undefined;
      const confidence = structured.confidence as number | undefined;

      // Findings should not contain obvious hallucinations
      if (findings) {
        for (const finding of findings) {
          if (
            finding.includes("I cannot") ||
            finding.includes("I don't have access") ||
            finding.includes("As an AI")
          ) {
            errors.push(`Finding contains AI refusal phrase: "${finding}"`);
          }
        }
      }

      // Confidence should reflect data quality
      if (confidence && confidence < 0.3 && output.success) {
        warnings.push("Low confidence (< 0.3) but output marked as success");
      }
      break;
    }

    case "outbound_call": {
      const structured = output.structured as Record<string, unknown>;
      const callStatus = structured.callStatus as string | undefined;
      const callDuration = structured.callDuration as number | undefined;

      // Duration should only be present for connected calls
      if (callDuration && callDuration > 0 && callStatus !== "connected") {
        errors.push(`Call duration present (${callDuration}s) but status is ${callStatus}`);
      }

      // Connected calls should have reasonable duration
      if (callStatus === "connected" && (!callDuration || callDuration < 10)) {
        warnings.push("Connected call with very short duration (< 10s)");
      }
      break;
    }

    case "send_email": {
      const structured = output.structured as Record<string, unknown>;
      const recipient = structured.recipient as string | undefined;
      const deliveryStatus = structured.deliveryStatus as string | undefined;

      // Recipient should be a valid email
      if (recipient && !recipient.includes("@")) {
        errors.push(`Invalid email recipient: ${recipient}`);
      }

      // Sent emails should have a message ID
      if (deliveryStatus === "sent" && !structured.messageId) {
        warnings.push("Email marked as sent but no messageId provided");
      }
      break;
    }

    case "data_entry": {
      const structured = output.structured as Record<string, unknown>;
      const recordsCreated = structured.recordsCreated as number | undefined;
      const recordsUpdated = structured.recordsUpdated as number | undefined;
      const successRate = structured.successRate as number | undefined;

      // Success rate should match record counts
      if (
        successRate !== undefined &&
        recordsCreated !== undefined &&
        recordsUpdated !== undefined
      ) {
        const total = recordsCreated + recordsUpdated;
        const calculatedRate = total > 0 ? total / (total + (structured.recordsSkipped as number || 0)) : 0;

        if (Math.abs(successRate - calculatedRate) > 0.05) {
          warnings.push(
            `Success rate (${successRate}) doesn't match record counts (calculated: ${calculatedRate})`
          );
        }
      }
      break;
    }
  }

  return { errors, warnings };
}

/**
 * Quick check: is this output likely to be valid?
 * Used for confidence-gating before execution.
 */
export function estimateOutputQuality(
  actionType: ActionType,
  output: StructuredActionOutput
): number {
  // 0–1 confidence that this output is correct
  const validation = validateStructuredOutput(actionType, output);

  if (!validation.valid) {
    return Math.max(0, 0.5 - validation.errors.length * 0.1);
  }

  let confidence = validation.confidence;

  // Boost confidence if output has supporting data
  if (output.structured && Object.keys(output.structured).length > 3) {
    confidence *= 1.1;
  }

  // Reduce confidence if execution time is suspiciously fast (< 100ms for research)
  if (actionType === "web_research" && output.executionTimeMs && output.executionTimeMs < 100) {
    confidence *= 0.7;
  }

  return Math.max(0, Math.min(1, confidence));
}
