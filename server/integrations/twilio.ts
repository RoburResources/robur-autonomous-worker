/**
 * Twilio SMS Integration
 * Handles outbound SMS and inbound webhook processing
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";

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
  if (isPrivateCandidateInternalOnly()) {
    console.warn("[Twilio] SMS blocked by private-candidate containment");
    return { sid: "blocked", status: "blocked_private_candidate" };
  }

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
  const sid = typeof data.sid === "string" ? data.sid.trim() : "";
  if (!/^SM[0-9a-fA-F]{32}$/.test(sid)) {
    throw new Error(
      "Twilio accepted the request without a valid Message SID; outcome requires reconciliation"
    );
  }
  return {
    sid,
    status: data.status || "sent",
  };
}

export function stringFormFields(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") return null;
    fields[key] = value;
  }
  return fields;
}

/**
 * Return the exact HTTPS URL Twilio signs. Provider connection overrides live
 * in the fragment, which is not part of an HTTP request and must not be signed.
 */
export function canonicalTwilioSigningUrl(webhookUrl: string): string | null {
  const exactUrl = webhookUrl.trim();
  if (!exactUrl || exactUrl !== webhookUrl) return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(exactUrl);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    !parsedUrl.hostname ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    return null;
  }

  const fragmentIndex = exactUrl.indexOf("#");
  return fragmentIndex === -1 ? exactUrl : exactUrl.slice(0, fragmentIndex);
}

/** Build Twilio's canonical URL + sorted form-fields signing payload. */
export function canonicalTwilioSigningPayload(
  webhookUrl: string,
  body: Record<string, string>
): string | null {
  const signingUrl = canonicalTwilioSigningUrl(webhookUrl);
  if (!signingUrl) return null;

  let signedPayload = signingUrl;
  for (const key of Object.keys(body).sort()) {
    signedPayload += `${key}${body[key]}`;
  }
  return signedPayload;
}

/** Official Twilio form-signature calculation: URL + sorted form fields. */
export function computeTwilioSignature(
  authToken: string,
  webhookUrl: string,
  body: Record<string, string>
): string {
  const signedPayload = canonicalTwilioSigningPayload(webhookUrl, body);
  if (!signedPayload) {
    throw new Error(
      "Twilio webhook URL must be HTTPS without embedded credentials"
    );
  }

  return createHmac("sha1", authToken)
    .update(signedPayload, "utf8")
    .digest("base64");
}

/**
 * Validate bounded Twilio connection overrides configured in a provider URL.
 * The retry policy may retry all failures, or exactly connection, read-timeout,
 * and 5xx failures.
 */
export function validateTwilioRetryConfiguration(
  providerWebhookUrl: string
): boolean {
  if (!canonicalTwilioSigningUrl(providerWebhookUrl)) return false;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(providerWebhookUrl);
  } catch {
    return false;
  }

  if (!parsedUrl.hash) return false;

  const overrides = new URLSearchParams(parsedUrl.hash.slice(1));
  const retryCounts = overrides.getAll("rc");
  const totalTimeouts = overrides.getAll("tt");
  const retryPolicies = overrides.getAll("rp");
  if (
    retryCounts.length !== 1 ||
    totalTimeouts.length !== 1 ||
    retryPolicies.length !== 1
  ) {
    return false;
  }

  const retryCountText = retryCounts[0];
  const totalTimeoutText = totalTimeouts[0];
  if (!/^\d+$/.test(retryCountText) || !/^\d+$/.test(totalTimeoutText)) {
    return false;
  }

  const retryCount = Number(retryCountText);
  const totalTimeoutMs = Number(totalTimeoutText);
  if (
    retryCount < 2 ||
    retryCount > 5 ||
    totalTimeoutMs < 10_000 ||
    totalTimeoutMs > 15_000
  ) {
    return false;
  }

  const retryPolicy = retryPolicies[0];
  if (retryPolicy === "all") return true;

  const policyValues = retryPolicy.split(",");
  const requiredPolicies = new Set(["ct", "rt", "5xx"]);
  return (
    policyValues.length === requiredPolicies.size &&
    new Set(policyValues).size === requiredPolicies.size &&
    policyValues.every((value) => requiredPolicies.has(value))
  );
}

/**
 * Validate the exact Twilio signature against a configured canonical HTTPS
 * webhook URL. We do not derive the URL from proxy-controlled headers.
 */
export function validateTwilioWebhook(
  req: Request,
  webhookUrl = process.env.TWILIO_SMS_WEBHOOK_URL || ""
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  const signature = req.get("x-twilio-signature") || "";
  const formFields = stringFormFields(req.body);
  const signedPayload =
    formFields && canonicalTwilioSigningPayload(webhookUrl, formFields);

  if (!authToken || !signature || !signedPayload) {
    return false;
  }

  const expected = Buffer.from(
    createHmac("sha1", authToken)
      .update(signedPayload, "utf8")
      .digest("base64"),
    "utf8"
  );
  const supplied = Buffer.from(signature, "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function isVerifiedOwnerSmsRequest(req: Request): boolean {
  const ownerPhone = process.env.OWNER_PHONE_E164 || "";
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER || "";
  const accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  const formFields = stringFormFields(req.body);
  const sender = formFields?.From || "";
  const destination = formFields?.To || "";
  const requestAccountSid = formFields?.AccountSid || "";

  return (
    /^\+[1-9]\d{7,14}$/.test(ownerPhone) &&
    /^\+[1-9]\d{7,14}$/.test(twilioPhone) &&
    /^AC[0-9a-fA-F]{32}$/.test(accountSid) &&
    sender === ownerPhone &&
    destination === twilioPhone &&
    requestAccountSid === accountSid &&
    validateTwilioWebhook(req)
  );
}

export function isVerifiedOwnerVoiceRequest(req: Request): boolean {
  const ownerPhone = process.env.OWNER_PHONE_E164 || "";
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER || "";
  const voiceWebhookUrl = process.env.TWILIO_VOICE_WEBHOOK_URL || "";
  const formFields = stringFormFields(req.body);

  return (
    /^\+[1-9]\d{7,14}$/.test(ownerPhone) &&
    /^\+[1-9]\d{7,14}$/.test(twilioPhone) &&
    formFields?.From === ownerPhone &&
    formFields?.To === twilioPhone &&
    validateTwilioWebhook(req, voiceWebhookUrl)
  );
}

/**
 * Parse inbound SMS from Twilio webhook
 */
export function parseInboundSMS(body: unknown): {
  from: string;
  to: string;
  accountSid: string;
  message: string;
  messageSid: string;
} {
  const fields = stringFormFields(body) || {};
  return {
    from: fields.From || "",
    to: fields.To || "",
    accountSid: fields.AccountSid || "",
    message: (fields.Body || "").trim(),
    messageSid: fields.MessageSid || "",
  };
}
