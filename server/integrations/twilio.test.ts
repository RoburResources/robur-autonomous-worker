import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  computeTwilioSignature,
  isVerifiedOwnerSmsRequest,
  validateTwilioWebhook,
} from "./twilio";

const webhookUrl = "https://worker.example.com/api/webhooks/sms";
const authToken = "test-auth-token";
const ownerPhone = "+61400000000";

function requestFor(body: Record<string, string>, signature?: string): Request {
  return {
    body,
    get: (name: string) =>
      name.toLowerCase() === "x-twilio-signature" ? signature : undefined,
  } as unknown as Request;
}

describe("Twilio webhook authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts a valid signature only for the configured canonical URL", () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
    vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", webhookUrl);
    const body = {
      Body: "STATUS",
      From: ownerPhone,
      MessageSid: "SM00000000000000000000000000000000",
    };
    const signature = computeTwilioSignature(authToken, webhookUrl, body);

    expect(validateTwilioWebhook(requestFor(body, signature))).toBe(true);
  });

  it("rejects a modified payload", () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
    vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", webhookUrl);
    const signedBody = {
      Body: "STATUS",
      From: ownerPhone,
      MessageSid: "SM00000000000000000000000000000000",
    };
    const signature = computeTwilioSignature(authToken, webhookUrl, signedBody);

    expect(
      validateTwilioWebhook(
        requestFor({ ...signedBody, Body: "START" }, signature)
      )
    ).toBe(false);
  });

  it("rejects a valid Twilio signature from any non-owner sender", () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
    vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", webhookUrl);
    vi.stubEnv("OWNER_PHONE_E164", ownerPhone);
    const body = {
      Body: "START",
      From: "+61499999999",
      MessageSid: "SM00000000000000000000000000000000",
    };
    const signature = computeTwilioSignature(authToken, webhookUrl, body);

    expect(isVerifiedOwnerSmsRequest(requestFor(body, signature))).toBe(false);
  });

  it("fails closed when webhook configuration is missing", () => {
    expect(
      validateTwilioWebhook(
        requestFor({ Body: "START", From: ownerPhone }, "anything")
      )
    ).toBe(false);
  });
});
