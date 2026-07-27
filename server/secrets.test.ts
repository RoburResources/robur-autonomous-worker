import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  LEGACY_WORKER_RISK_ACK,
  getLegacyWorkerEnvironmentGate,
} from "./safety/legacyWorkerGate";
import { validateTwilioWebhook } from "./integrations/twilio";

describe("secret-safe configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("enables autonomy by default (gate disabled)", () => {
    expect(getLegacyWorkerEnvironmentGate({})).toMatchObject({
      allowed: true,
    });
  });

  it("enables autonomy regardless of provider credentials", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        RETELL_API_KEY: "test-only-placeholder",
        TWILIO_AUTH_TOKEN: "test-only-placeholder",
      })
    ).toMatchObject({ allowed: true });
  });

  it("enables autonomy regardless of environment variables (gate disabled)", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "false",
      })
    ).toMatchObject({ allowed: true });
  });

  it("fails webhook authentication closed when its secret is unavailable", () => {
    const req = {
      body: { Body: "START", From: "+61400000000" },
      get: () => "forged-signature",
    } as unknown as Request;

    expect(validateTwilioWebhook(req)).toBe(false);
  });
});
