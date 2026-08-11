import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  computeRetellWebhookDigest,
  isVerifiedRetellRequest,
  verifyRetellWebhookSignature,
} from "./retellWebhookAuth";

const apiKey = "retell-test-key";
const rawBody = '{"event":"call_ended","call":{"call_id":"call_12345678"}}';
const now = 1_785_370_000_000;

function signature(body = rawBody, timestamp = now): string {
  const timestampText = String(timestamp);
  return `v=${timestampText},d=${computeRetellWebhookDigest(
    body,
    apiKey,
    timestampText
  )}`;
}

describe("Retell raw-body webhook authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the exact documented fresh signature", () => {
    expect(
      verifyRetellWebhookSignature(rawBody, apiKey, signature(), now)
    ).toBe(true);
  });

  it("rejects a reserialized or modified body", () => {
    expect(
      verifyRetellWebhookSignature(
        rawBody + " ",
        apiKey,
        signature(),
        now
      )
    ).toBe(false);
  });

  it("rejects stale, future, malformed, and wrong-length signatures", () => {
    expect(
      verifyRetellWebhookSignature(
        rawBody,
        apiKey,
        signature(rawBody, now - 5 * 60_000 - 1),
        now
      )
    ).toBe(false);
    expect(
      verifyRetellWebhookSignature(
        rawBody,
        apiKey,
        signature(rawBody, now + 5 * 60_000 + 1),
        now
      )
    ).toBe(false);
    expect(
      verifyRetellWebhookSignature(rawBody, apiKey, "not-a-signature", now)
    ).toBe(false);
    expect(
      verifyRetellWebhookSignature(rawBody, apiKey, `v=${now},d=ab`, now)
    ).toBe(false);
  });

  it("requires the captured raw request body and header", () => {
    vi.stubEnv("RETELL_WEBHOOK_API_KEY", apiKey);
    const req = {
      body: JSON.parse(rawBody),
      get: () => signature(),
    } as unknown as Request;
    expect(isVerifiedRetellRequest(req, now)).toBe(false);
  });
});
