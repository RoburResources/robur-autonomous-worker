import { describe, expect, it } from "vitest";

describe("Secrets Validation", () => {
  it("RETELL_API_KEY should be configured", () => {
    const key = process.env.RETELL_API_KEY;
    expect(key).toBeDefined();
    expect(key!.length).toBeGreaterThan(10);
    expect(key).toMatch(/^key_/);
  });

  it("RETELL_AGENT_ID should be configured", () => {
    const id = process.env.RETELL_AGENT_ID;
    expect(id).toBeDefined();
    expect(id).toMatch(/^agent_/);
  });

  it("USER_PHONE should be configured with Australian format", () => {
    const phone = process.env.USER_PHONE;
    expect(phone).toBeDefined();
    expect(phone).toMatch(/^\+61/);
  });

  it("TWILIO_ACCOUNT_SID should be configured", () => {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    expect(sid).toBeDefined();
    expect(sid!.length).toBeGreaterThan(10);
  });

  it("TWILIO_AUTH_TOKEN should be configured", () => {
    const token = process.env.TWILIO_AUTH_TOKEN;
    expect(token).toBeDefined();
    expect(token!.length).toBeGreaterThan(10);
  });

  it("TWILIO_PHONE_NUMBER should be configured", () => {
    const phone = process.env.TWILIO_PHONE_NUMBER;
    expect(phone).toBeDefined();
    expect(phone!.length).toBeGreaterThan(5);
  });
});
