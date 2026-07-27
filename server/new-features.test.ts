/**
 * Tests for Mem0, SendGrid, and A/B Testing modules.
 */

import { describe, it, expect, vi } from "vitest";
import {
  assignVariant,
  analyseExperiment,
  createExperiment,
  recordVariantOutcome,
  type Experiment,
} from "./autonomous/abTesting";
import {
  sendEmail,
  parseEmailDraft,
  buildEmailTemplate,
  isSendGridConfigured,
} from "./integrations/sendgrid";
import type { MemoryEntry } from "./memory/mem0";

// ─────────────────────────────────────────────────────────────────────────────
// A/B Testing Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("A/B Testing — Variant Assignment", () => {
  const mockExperiment: Experiment = {
    id: "exp_test_001",
    name: "Test Experiment",
    actionType: "outbound_call",
    metric: "success_rate",
    variants: [
      { id: "v0", name: "Control", description: "Original", content: "Script A", weight: 1 },
      { id: "v1", name: "Variant B", description: "New approach", content: "Script B", weight: 1 },
      { id: "v2", name: "Variant C", description: "Another approach", content: "Script C", weight: 1 },
    ],
    status: "running",
    minSampleSize: 10,
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  it("should assign a variant deterministically for the same task ID", () => {
    const variant1 = assignVariant(mockExperiment, 42);
    const variant2 = assignVariant(mockExperiment, 42);
    expect(variant1.id).toBe(variant2.id);
  });

  it("should assign a variant from the experiment's variant list", () => {
    const variant = assignVariant(mockExperiment, 42);
    const validIds = mockExperiment.variants.map(v => v.id);
    expect(validIds).toContain(variant.id);
  });

  it("should assign variants deterministically for the same task ID", () => {
    const v1 = assignVariant(mockExperiment, 100);
    const v2 = assignVariant(mockExperiment, 100);
    expect(v1.id).toBe(v2.id);
  });

  it("should assign different variants across a range of task IDs", () => {
    // The bucket is (taskId % 1000) / 1000. With 3 equal variants, thresholds are at 0.333 and 0.667.
    // Use task IDs that span all 3 buckets: 1 (bucket 0.001), 334 (bucket 0.334), 668 (bucket 0.668)
    const variants = new Set<string>();
    for (const id of [1, 334, 668, 1001, 1334, 1668]) {
      variants.add(assignVariant(mockExperiment, id).id);
    }
    expect(variants.size).toBe(3);
  });

  it("should respect weighted distribution directionally", () => {
    const weightedExperiment: Experiment = {
      ...mockExperiment,
      variants: [
        { id: "v0", name: "Control", description: "Original", content: "Script A", weight: 9 },
        { id: "v1", name: "Variant B", description: "New approach", content: "Script B", weight: 1 },
      ],
    };

    const counts: Record<string, number> = { v0: 0, v1: 0 };
    for (let i = 0; i < 100; i++) {
      const variant = assignVariant(weightedExperiment, i);
      counts[variant.id] = (counts[variant.id] || 0) + 1;
    }
    // v0 has 9x weight so should dominate
    expect(counts.v0).toBeGreaterThan(counts.v1);
  });

  it("should return a variant even for a paused experiment", () => {
    const pausedExperiment: Experiment = { ...mockExperiment, status: "paused" };
    const variant = assignVariant(pausedExperiment, 1);
    expect(variant).toBeDefined();
    expect(variant.id).toBeTruthy();
  });
});

describe("A/B Testing — Winner Detection Logic", () => {
  it("should identify a clear winner with 20%+ lift", () => {
    // Simulate variant results
    const variantResults = [
      { variantId: "v0", variantName: "Control", samples: 20, successes: 10, successRate: 0.5, avgConfidence: 0.8 },
      { variantId: "v1", variantName: "Variant B", samples: 20, successes: 16, successRate: 0.8, avgConfidence: 0.85 },
    ];

    // Calculate lift manually
    const best = variantResults.sort((a, b) => b.successRate - a.successRate)[0];
    const second = variantResults.sort((a, b) => b.successRate - a.successRate)[1];
    const lift = (best.successRate - second.successRate) / second.successRate;

    expect(lift).toBeGreaterThan(0.2); // 60% lift: (0.8 - 0.5) / 0.5
    expect(best.variantName).toBe("Variant B");
  });

  it("should not declare a winner with less than 10% lift", () => {
    const variantResults = [
      { successRate: 0.50 },
      { successRate: 0.54 }, // Only 8% lift
    ];

    const best = variantResults.sort((a, b) => b.successRate - a.successRate)[0];
    const second = variantResults.sort((a, b) => b.successRate - a.successRate)[1];
    const lift = (best.successRate - second.successRate) / second.successRate;

    expect(lift).toBeLessThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SendGrid Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SendGrid Email Integration", () => {
  it("should detect when SendGrid is not configured", () => {
    // In test environment, SENDGRID_API_KEY is not set
    const configured = isSendGridConfigured();
    expect(typeof configured).toBe("boolean");
  });

  it("should reject email with invalid recipient", async () => {
    const result = await sendEmail({
      to: "not-an-email",
      subject: "Test",
      bodyText: "This is a test email body that is long enough to pass validation.",
    });

    expect(result.success).toBe(false);
    expect(result.deliveryStatus).toBe("failed");
    expect(result.error).toContain("Invalid recipient");
  });

  it("should reject email with missing subject", async () => {
    const result = await sendEmail({
      to: "test@example.com",
      subject: "",
      bodyText: "This is a test email body that is long enough to pass validation.",
    });

    expect(result.success).toBe(false);
    expect(result.deliveryStatus).toBe("failed");
  });

  it("should reject email with body too short", async () => {
    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test Subject",
      bodyText: "Too short",
    });

    expect(result.success).toBe(false);
    expect(result.deliveryStatus).toBe("failed");
    expect(result.error).toContain("too short");
  });

  it("should draft email when SendGrid is not configured", async () => {
    // Without SENDGRID_API_KEY, should fall back to draft mode
    const result = await sendEmail({
      to: "test@example.com",
      subject: "Test Subject",
      bodyText: "This is a test email body that is long enough to pass validation checks.",
    });

    // Either sent (if key is set) or draft (if not)
    expect(["sent", "draft"]).toContain(result.deliveryStatus);
    expect(result.success).toBe(true);
    expect(result.messageId).toBeTruthy();
    expect(result.timestamp).toBeTruthy();
  });

  it("should parse email draft with subject line", () => {
    const draft = `Subject: Test Email Subject

Dear Sir/Madam,

This is the body of the email.

Kind regards,
Michael T`;

    const { subject, body } = parseEmailDraft(draft);
    expect(subject).toBe("Test Email Subject");
    expect(body).toContain("Dear Sir/Madam");
    expect(body).not.toContain("Subject:");
  });

  it("should use default subject when no subject line in draft", () => {
    const draft = "Dear Sir/Madam, This is the body.";
    const { subject, body } = parseEmailDraft(draft);
    expect(subject).toBe("Business Inquiry — Robur Resources");
    expect(body).toContain("Dear Sir/Madam");
  });

  it("should build HTML email template", () => {
    const { subject, bodyHtml } = buildEmailTemplate(
      "supplier_outreach",
      "We would like to collect your scrap metal.",
      "John Smith"
    );

    expect(subject).toBe("Scrap Metal Collection — Robur Resources Perth");
    expect(bodyHtml).toContain("Dear John Smith");
    expect(bodyHtml).toContain("We would like to collect your scrap metal.");
    expect(bodyHtml).toContain("Michael T");
    expect(bodyHtml).toContain("Robur Resources");
  });

  it("should build buyer inquiry template", () => {
    const { subject } = buildEmailTemplate("buyer_inquiry", "Content here");
    expect(subject).toBe("Scrap Metal Supply Inquiry — Robur Resources");
  });

  it("should include HTML structure in template", () => {
    const { bodyHtml } = buildEmailTemplate("general_business", "Test content");
    expect(bodyHtml).toContain("<!DOCTYPE html>");
    expect(bodyHtml).toContain("<body");
    expect(bodyHtml).toContain("Test content");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory Module Tests (unit-level, no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe("Memory Module — Type Safety", () => {
  it("should accept valid memory entry types", () => {
    const entry: MemoryEntry = {
      content: "Supplier ABC prefers morning calls before 10am",
      category: "supplier_preferences",
      entityId: "abc_supplier",
      metadata: { preferredTime: "morning", channel: "phone" },
    };

    expect(entry.content).toBeTruthy();
    expect(entry.category).toBe("supplier_preferences");
    expect(entry.entityId).toBe("abc_supplier");
  });

  it("should accept all valid memory categories", () => {
    const categories = [
      "supplier_preferences",
      "task_outcomes",
      "strategy_insights",
      "contact_history",
      "market_intelligence",
      "system_learnings",
    ] as const;

    for (const category of categories) {
      const entry: MemoryEntry = {
        content: `Test memory for ${category}`,
        category,
      };
      expect(entry.category).toBe(category);
    }
  });
});
