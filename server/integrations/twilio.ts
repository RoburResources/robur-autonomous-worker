/**
 * Twilio SMS Integration
 * Handles outbound SMS and inbound webhook processing
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

function getTwilioCredentials() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  };
}

/**
 * Send an SMS via Twilio REST API
 */
export async function sendSMS(
  to: string,
  body: string
): Promise<{ sid: string; status: string }> {
  const { accountSid, authToken, phoneNumber } = getTwilioCredentials();

  if (!accountSid || !authToken || !phoneNumber) {
    console.warn("[Twilio] Credentials not configured, SMS not sent:", {
      to,
      body: body.substring(0, 50),
    });
    return { sid: "not_configured", status: "skipped" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: phoneNumber,
      Body: body,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio SMS error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    sid: data.sid || "unknown",
    status: data.status || "sent",
  };
}

function stringFormFields(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") return null;
    fields[key] = value;
  }
  return fields;
}

/** Official Twilio form-signature calculation: URL + sorted form fields. */
export function computeTwilioSignature(
  authToken: string,
  webhookUrl: string,
  body: Record<string, string>
): string {
  let signedPayload = webhookUrl;
  for (const key of Object.keys(body).sort()) {
    signedPayload += `${key}${body[key]}`;
  }
  return createHmac("sha1", authToken)
    .update(signedPayload, "utf8")
    .digest("base64");
}

/**
 * Validate the exact Twilio signature against a configured canonical HTTPS
 * webhook URL. We do not derive the URL from proxy-controlled headers.
 */
export function validateTwilioWebhook(req: Request): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const webhookUrl = process.env.TWILIO_SMS_WEBHOOK_URL || "";
  const signature = req.get("x-twilio-signature") || "";
  const formFields = stringFormFields(req.body);

  if (
    !authToken ||
    !webhookUrl.startsWith("https://") ||
    !signature ||
    !formFields
  ) {
    return false;
  }

  const expected = Buffer.from(
    computeTwilioSignature(authToken, webhookUrl, formFields),
    "utf8"
  );
  const supplied = Buffer.from(signature, "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function isVerifiedOwnerSmsRequest(req: Request): boolean {
  const ownerPhone = process.env.OWNER_PHONE_E164 || "";
  const formFields = stringFormFields(req.body);
  const sender = formFields?.From || "";

  return (
    /^\+[1-9]\d{7,14}$/.test(ownerPhone) &&
    sender === ownerPhone &&
    validateTwilioWebhook(req)
  );
}

/**
 * Parse inbound SMS from Twilio webhook
 */
export function parseInboundSMS(body: unknown): {
  from: string;
  message: string;
  messageSid: string;
} {
  const fields = stringFormFields(body) || {};
  return {
    from: fields.From || "",
    message: (fields.Body || "").trim(),
    messageSid: fields.MessageSid || "",
  };
}
