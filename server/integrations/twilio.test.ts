import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  canonicalTwilioSigningPayload,
  canonicalTwilioSigningUrl,
  computeTwilioSignature,
  isVerifiedOwnerSmsRequest,
  isVerifiedOwnerVoiceRequest,
  parseInboundSMS,
  stringFormFields,
  validateTwilioRetryConfiguration,
  validateTwilioWebhook,
} from "./twilio";

const webhookUrl = "https://worker.example.com/api/webhooks/sms";
const providerWebhookUrl = `${webhookUrl}#rc=3&tt=12000&rp=ct,rt,5xx`;
const authToken = "test-auth-token";
const ownerPhone = "+61400000000";
const twilioPhone = "+61411111111";
const accountSid = `AC${"a".repeat(32)}`;

function requestFor(body: Record<string, string>, signature?: string): Request {
  return {
    body,
    get: (name: string) =>
      name.toLowerCase() === "x-twilio-signature" ? signature : undefined,
  } as unknown as Request;
}

function validSmsBody(): Record<string, string> {
  return {
    AccountSid: accountSid,
    Body: "STATUS",
    From: ownerPhone,
    MessageSid: "SM00000000000000000000000000000000",
    To: twilioPhone,
  };
}

function stubSmsEnvironment(url = webhookUrl): void {
  vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
  vi.stubEnv("TWILIO_PHONE_NUMBER", twilioPhone);
  vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", url);
  vi.stubEnv("OWNER_PHONE_E164", ownerPhone);
}

describe("Twilio webhook authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("exports only all-string form fields", () => {
    expect(stringFormFields({ Body: "STATUS", From: ownerPhone })).toEqual({
      Body: "STATUS",
      From: ownerPhone,
    });
    expect(stringFormFields({ Body: 42 })).toBeNull();
    expect(stringFormFields(["STATUS"])).toBeNull();
  });

  it("strips provider fragments from the canonical signing payload", () => {
    const body = { Zulu: "last", Alpha: "first" };

    expect(canonicalTwilioSigningUrl(providerWebhookUrl)).toBe(webhookUrl);
    expect(canonicalTwilioSigningPayload(providerWebhookUrl, body)).toBe(
      `${webhookUrl}AlphafirstZululast`
    );
    expect(
      computeTwilioSignature(authToken, providerWebhookUrl, body)
    ).toBe(computeTwilioSignature(authToken, webhookUrl, body));
  });

  it("rejects non-HTTPS and credential-bearing signing URLs", () => {
    const body = { Body: "STATUS" };
    const httpUrl = "http://worker.example.com/api/webhooks/sms";
    const credentialUrl =
      "https://user:password@worker.example.com/api/webhooks/sms";

    expect(canonicalTwilioSigningUrl(httpUrl)).toBeNull();
    expect(canonicalTwilioSigningUrl(credentialUrl)).toBeNull();
    expect(canonicalTwilioSigningPayload(httpUrl, body)).toBeNull();
    expect(() => computeTwilioSignature(authToken, credentialUrl, body)).toThrow(
      "Twilio webhook URL must be HTTPS without embedded credentials"
    );
  });

  it("accepts a valid signature against a configured URL with retry overrides", () => {
    stubSmsEnvironment(providerWebhookUrl);
    const body = validSmsBody();
    const signature = computeTwilioSignature(authToken, webhookUrl, body);

    expect(validateTwilioWebhook(requestFor(body, signature))).toBe(true);
    expect(isVerifiedOwnerSmsRequest(requestFor(body, signature))).toBe(true);
  });

  it("rejects a modified payload", () => {
    stubSmsEnvironment();
    const signedBody = validSmsBody();
    const signature = computeTwilioSignature(authToken, webhookUrl, signedBody);

    expect(
      validateTwilioWebhook(
        requestFor({ ...signedBody, Body: "START" }, signature)
      )
    ).toBe(false);
  });

  it("rejects signed SMS requests with a different sender, destination, or account", () => {
    stubSmsEnvironment();
    const mismatchedBodies = [
      { ...validSmsBody(), From: "+61499999999" },
      { ...validSmsBody(), To: "+61422222222" },
      { ...validSmsBody(), AccountSid: `AC${"b".repeat(32)}` },
    ];

    for (const body of mismatchedBodies) {
      const signature = computeTwilioSignature(authToken, webhookUrl, body);
      expect(isVerifiedOwnerSmsRequest(requestFor(body, signature))).toBe(false);
    }
  });

  it("parses the signed SMS identity fields", () => {
    expect(parseInboundSMS({ ...validSmsBody(), Body: "  START  " })).toEqual({
      accountSid,
      from: ownerPhone,
      message: "START",
      messageSid: "SM00000000000000000000000000000000",
      to: twilioPhone,
    });
  });

  it("fails closed when webhook configuration is missing", () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_SMS_WEBHOOK_URL", "");

    expect(
      validateTwilioWebhook(
        requestFor({ Body: "START", From: ownerPhone }, "anything")
      )
    ).toBe(false);
  });

  it.each([
    "https://worker.example.com/api/webhooks/sms#rc=2&tt=10000&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=5&tt=15000&rp=5xx,ct,rt",
  ])("accepts a bounded provider retry configuration: %s", (url) => {
    expect(validateTwilioRetryConfiguration(url)).toBe(true);
  });

  it.each([
    "https://worker.example.com/api/webhooks/sms",
    "http://worker.example.com/api/webhooks/sms#rc=3&tt=12000&rp=all",
    "https://user:password@worker.example.com/api/webhooks/sms#rc=3&tt=12000&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=1&tt=12000&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=6&tt=12000&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=3&tt=9999&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=3&tt=15001&rp=all",
    "https://worker.example.com/api/webhooks/sms#rc=3&tt=12000&rp=ct,rt",
    "https://worker.example.com/api/webhooks/sms#rc=3&tt=12000&rp=ct,rt,5xx,4xx",
    "https://worker.example.com/api/webhooks/sms#rc=3&rc=4&tt=12000&rp=all",
  ])("rejects an unsafe provider retry configuration: %s", (url) => {
    expect(validateTwilioRetryConfiguration(url)).toBe(false);
  });

  it("preserves owner-only voice webhook verification", () => {
    const voiceUrl = "https://worker.example.com/api/webhooks/voice/addison";
    vi.stubEnv("TWILIO_AUTH_TOKEN", authToken);
    vi.stubEnv("TWILIO_VOICE_WEBHOOK_URL", voiceUrl);
    vi.stubEnv("TWILIO_PHONE_NUMBER", twilioPhone);
    vi.stubEnv("OWNER_PHONE_E164", ownerPhone);
    const body = { From: ownerPhone, To: twilioPhone, CallSid: "CA123" };
    const signature = computeTwilioSignature(authToken, voiceUrl, body);

    expect(isVerifiedOwnerVoiceRequest(requestFor(body, signature))).toBe(true);
    expect(
      isVerifiedOwnerVoiceRequest(
        requestFor({ ...body, From: "+61499999999" }, signature)
      )
    ).toBe(false);
  });
});
