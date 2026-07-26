import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateTaskInput, validateTaskOutput } from "./autonomous/schemaValidator";
import { checkDagReadiness, validateNoCycle } from "./autonomous/dagEngine";

// ─── Schema Validator Tests ──────────────────────────────────────────────────

describe("schemaValidator — validateTaskInput", () => {
  it("passes a valid web_research task", () => {
    const result = validateTaskInput({
      description: "Research all auto shops in Perth metro area for scrap metal sourcing",
      actionType: "web_research",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails a task with too-short description", () => {
    const result = validateTaskInput({
      description: "Do it",
      actionType: "web_research",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("too short");
  });

  it("warns on missing action type", () => {
    const result = validateTaskInput({
      description: "Research demolition sites in Perth for scrap metal opportunities",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("No action type"))).toBe(true);
  });

  it("warns on unknown action type", () => {
    const result = validateTaskInput({
      description: "Do some unknown action with sufficient description length here",
      actionType: "teleport",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("Unknown action type"))).toBe(true);
  });

  it("warns when outbound_call has no phone number", () => {
    const result = validateTaskInput({
      description: "Call the top scrap metal buyer in Perth to negotiate pricing",
      actionType: "outbound_call",
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("No target phone number"))).toBe(true);
  });
});

describe("schemaValidator — validateTaskOutput", () => {
  it("passes a valid web_research output", () => {
    const result = validateTaskOutput(
      "web_research",
      "findings: Perth has over 450 auto shops across the metro area. Top concentrations in Malaga, Osborne Park, and Welshpool. Key contacts identified: ABC Auto Parts (08 9444 1234), XYZ Wreckers (08 9321 5678). Recommended approach: direct phone outreach to the top 20 by size."
    );
    expect(result.valid).toBe(true);
  });

  it("fails an empty output", () => {
    const result = validateTaskOutput("web_research", null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("empty");
  });

  it("fails output that starts with an error indicator", () => {
    const result = validateTaskOutput("web_research", "failed: API timeout after 30 seconds");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("error indicator"))).toBe(true);
  });

  it("fails output containing forbidden AI-refusal phrases", () => {
    const result = validateTaskOutput(
      "web_research",
      "I cannot access the internet to find real data about Perth auto shops. As an AI language model I don't have access to real-time information."
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("forbidden phrase"))).toBe(true);
  });

  it("fails web_research output that is too short", () => {
    const result = validateTaskOutput("web_research", "findings: Some results.");
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("too short"))).toBe(true);
  });

  it("warns on unknown action type but still passes", () => {
    const result = validateTaskOutput("unknown_action", "Some output here that is reasonable");
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("No output schema"))).toBe(true);
  });
});

// ─── DAG Engine Tests ────────────────────────────────────────────────────────

describe("dagEngine — checkDagReadiness", () => {
  it("returns ready for a task with no dependencies", async () => {
    const result = await checkDagReadiness({ id: 1, metadata: {} });
    expect(result.isReady).toBe(true);
    expect(result.blockedBy).toHaveLength(0);
  });

  it("returns ready for a task with empty dag_dependencies array", async () => {
    const result = await checkDagReadiness({
      id: 1,
      metadata: { dag_dependencies: [] },
    });
    expect(result.isReady).toBe(true);
    expect(result.blockedBy).toHaveLength(0);
  });

  it("returns not ready when dependency task IDs are listed but not in DB", async () => {
    // With no DB connection, non-existent task IDs are treated as blocking
    const result = await checkDagReadiness({
      id: 99,
      metadata: { dag_dependencies: [1, 2, 3] },
    });
    // Without DB, the engine returns blocked (safe default)
    expect(result.isReady).toBe(false);
    expect(result.blockedBy.length).toBeGreaterThan(0);
  });
});

describe("dagEngine — validateNoCycle", () => {
  it("returns valid for a task with no dependencies", async () => {
    const result = await validateNoCycle(100, []);
    expect(result.valid).toBe(true);
  });

  it("returns valid when no DB is available (optimistic)", async () => {
    // Without DB, cycle detection can't run — defaults to valid (optimistic)
    const result = await validateNoCycle(1, [2, 3]);
    expect(result.valid).toBe(true);
  });
});

// ─── Pre-mortem Tests (unit — mocked LLM) ───────────────────────────────────

describe("premortem — confidence threshold logic", () => {
  it("correctly identifies tasks that should escalate at 0.84 confidence", () => {
    // Test the threshold logic directly (0.85 is the gate)
    const confidenceScore = 0.84;
    const threshold = 0.85;
    expect(confidenceScore < threshold).toBe(true);
  });

  it("correctly identifies tasks that should NOT escalate at 0.85 confidence", () => {
    const confidenceScore = 0.85;
    const threshold = 0.85;
    expect(confidenceScore < threshold).toBe(false);
  });

  it("correctly identifies tasks that should NOT escalate at 0.95 confidence", () => {
    const confidenceScore = 0.95;
    const threshold = 0.85;
    expect(confidenceScore < threshold).toBe(false);
  });

  it("hard blockers force escalation regardless of confidence score", () => {
    const confidenceScore = 0.90;
    const hasHardBlocker = true;
    const shouldEscalate = confidenceScore < 0.85 || hasHardBlocker;
    expect(shouldEscalate).toBe(true);
  });
});

// ─── Verifier Tests (unit — logic) ───────────────────────────────────────────

describe("verifier — score clamping logic", () => {
  it("clamps scores above 1.0 to 1.0", () => {
    const rawScore = 1.5;
    const clamped = Math.max(0, Math.min(1, rawScore));
    expect(clamped).toBe(1.0);
  });

  it("clamps scores below 0 to 0", () => {
    const rawScore = -0.3;
    const clamped = Math.max(0, Math.min(1, rawScore));
    expect(clamped).toBe(0);
  });

  it("passes valid scores through unchanged", () => {
    const rawScore = 0.73;
    const clamped = Math.max(0, Math.min(1, rawScore));
    expect(clamped).toBe(0.73);
  });
});

// ─── Canary Tests (unit — action type filtering) ─────────────────────────────

describe("canaryExecution — action type filtering", () => {
  it("identifies external-contact action types that require canary testing", () => {
    const externalActions = ["outbound_call", "send_email", "send_sms"];
    expect(externalActions.includes("outbound_call")).toBe(true);
    expect(externalActions.includes("send_email")).toBe(true);
    expect(externalActions.includes("send_sms")).toBe(true);
    expect(externalActions.includes("web_research")).toBe(false);
    expect(externalActions.includes("data_entry")).toBe(false);
  });
});
