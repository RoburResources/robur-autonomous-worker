import { describe, expect, it } from "vitest";
import { ownerSmsChannelCertified } from "./smsChannelCertification";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    OWNER_SMS_COMMAND_CHANNEL_CERTIFIED: "true",
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "a".repeat(32),
    TWILIO_PHONE_NUMBER: "+61411111111",
    OWNER_PHONE_E164: "+61400000000",
    TWILIO_SMS_WEBHOOK_URL:
      "https://worker.example.test/api/webhooks/sms#rc=3&tt=12000&rp=ct,rt,5xx",
  };
}

describe("owner SMS channel release gate", () => {
  it("accepts only the complete bounded provider configuration", () => {
    expect(ownerSmsChannelCertified(validEnvironment())).toBe(true);
  });

  it.each([
    "OWNER_SMS_COMMAND_CHANNEL_CERTIFIED",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "OWNER_PHONE_E164",
    "TWILIO_SMS_WEBHOOK_URL",
  ])("fails closed when %s is missing", key => {
    const env = validEnvironment();
    delete env[key];
    expect(ownerSmsChannelCertified(env)).toBe(false);
  });

  it("rejects the provider's unsafe default retry policy", () => {
    expect(
      ownerSmsChannelCertified({
        ...validEnvironment(),
        TWILIO_SMS_WEBHOOK_URL:
          "https://worker.example.test/api/webhooks/sms",
      })
    ).toBe(false);
  });

  it.each([
    "your_twilio_auth_token_here",
    "bounded-test-token",
    "a".repeat(31),
    "g".repeat(32),
  ])("rejects placeholder or malformed signing material: %s", token => {
    expect(
      ownerSmsChannelCertified({
        ...validEnvironment(),
        TWILIO_AUTH_TOKEN: token,
      })
    ).toBe(false);
  });
});
