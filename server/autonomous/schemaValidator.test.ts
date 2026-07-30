import { describe, expect, it } from "vitest";
import { validateTaskInput, validateTaskOutput } from "./schemaValidator";

describe("validateTaskInput canonical action payloads", () => {
  it("recognizes the canonical email recipient key", () => {
    const result = validateTaskInput({
      description: "Send the approved project update to the owner.",
      actionType: "send_email",
      actionPayload: { email: "owner@example.test" },
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).not.toContain(
      "No target email address in actionPayload — email will be drafted only"
    );
  });

  it("warns when an email task has no canonical recipient", () => {
    const result = validateTaskInput({
      description: "Prepare an email draft for later owner review.",
      actionType: "send_email",
      actionPayload: { subject: "Draft update" },
    });

    expect(result.warnings).toContain(
      "No target email address in actionPayload — email will be drafted only"
    );
  });
});

describe("validateTaskOutput action contracts", () => {
  it("fails closed for an explicit unknown action type", () => {
    const result = validateTaskInput({
      description: "Attempt an unsupported operation with enough description.",
      actionType: "teleport",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unknown action type: teleport");
  });

  it("rejects output that omits its declared required field", () => {
    const result = validateTaskOutput(
      "data_entry",
      "The operation appears to have completed successfully."
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Output is missing required field: result");
  });

  it("validates minimum length on the labeled field value", () => {
    const result = validateTaskOutput("data_entry", "result: short");

    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.includes("too short"))).toBe(true);
  });

  it("rejects unknown output contracts", () => {
    const result = validateTaskOutput(
      "teleport",
      "result: This output must not receive an implicit schema bypass."
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "No output schema defined for action type: teleport"
    );
  });
});
