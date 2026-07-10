import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  LEGACY_WORKER_RISK_ACK,
  getLegacyWorkerEnvironmentGate,
} from "./safety/legacyWorkerGate";
import { validateTwilioWebhook } from "./integrations/twilio";

describe("secret-safe configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not require provider secrets while the legacy worker is retired", () => {
    expect(getLegacyWorkerEnvironmentGate({})).toMatchObject({
      allowed: false,
    });
  });

  it("does not enable autonomy merely because provider credentials exist", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        RETELL_API_KEY: "test-only-placeholder",
        TWILIO_AUTH_TOKEN: "test-only-placeholder",
      })
    ).toMatchObject({ allowed: false });
  });

  it("requires explicit risk acknowledgement and a configured owner identity", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "true",
        LEGACY_WORKER_RISK_ACK,
      })
    ).toMatchObject({ allowed: false });
  });

  it("fails webhook authentication closed when its secret is unavailable", () => {
    const req = {
      body: { Body: "START", From: "+61400000000" },
      get: () => "forged-signature",
    } as unknown as Request;

    expect(validateTwilioWebhook(req)).toBe(false);
  });
});
