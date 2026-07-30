import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getLegacyWorkerRuntimeGate: vi.fn(),
}));

vi.mock("../db", () => ({
  getConfig: mocks.getConfig,
}));

vi.mock("../safety/legacyWorkerGate", () => ({
  getLegacyWorkerRuntimeGate: mocks.getLegacyWorkerRuntimeGate,
}));

import {
  parsePositiveIntegerLimit,
  runPreflightValidation,
} from "./preflightValidator";

describe("runPreflightValidation email credentials", () => {
  const originalSendgridKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SENDGRID_API_KEY;
    mocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    mocks.getConfig.mockImplementation(async (key: string) => {
      if (key === "max_api_spend_cents_per_day") return "5000";
      if (key === "max_calls_per_day") return "20";
      if (key === "max_emails_per_day") return "100";
      return null;
    });
  });

  afterEach(() => {
    if (originalSendgridKey === undefined) {
      delete process.env.SENDGRID_API_KEY;
    } else {
      process.env.SENDGRID_API_KEY = originalSendgridKey;
    }
  });

  it("fails closed when a real recipient is present without a SendGrid key", async () => {
    const result = await runPreflightValidation({
      actionType: "send_email",
      actionPayload: { email: "owner@example.test" },
      description: "Send the approved owner email artifact.",
    });

    expect(result.canExecute).toBe(false);
    expect(result.missingCredentials).toContain("SENDGRID_API_KEY not configured");
  });

  it("allows a recipient-free email to remain an explicitly warned draft", async () => {
    const result = await runPreflightValidation({
      actionType: "send_email",
      description: "Prepare an owner-reviewable email draft only.",
    });

    expect(result.canExecute).toBe(true);
    expect(result.warnings).toContain(
      "No email recipient configured — email will remain a draft",
    );
  });
});

describe("parsePositiveIntegerLimit", () => {
  it.each([
    ["not-a-number", null],
    ["20calls", null],
    ["1.5", null],
    ["", null],
    ["9007199254740992", null],
    ["0", null],
    ["-1", null],
    ["20", 20],
  ])("parses %j without failing open", (raw, expected) => {
    expect(parsePositiveIntegerLimit(raw, 100)).toBe(expected);
  });

  it("uses the safe default only when the stored limit is absent", () => {
    expect(parsePositiveIntegerLimit(null, 20)).toBe(20);
    expect(parsePositiveIntegerLimit(undefined, 100)).toBe(100);
  });
});
