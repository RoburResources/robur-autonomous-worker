import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { getRawJsonBody } from "../_core/rawBody";

const RETELL_SIGNATURE_MAX_AGE_MS = 5 * 60_000;
const RETELL_SIGNATURE_PATTERN = /^v=(\d+),d=([a-fA-F0-9]{64})$/;

export function computeRetellWebhookDigest(
  rawBody: string,
  apiKey: string,
  timestamp: string
): string {
  return createHmac("sha256", apiKey)
    .update(rawBody + timestamp, "utf8")
    .digest("hex");
}

/**
 * Verify Retell's documented v=<timestamp>,d=<HMAC-SHA256> signature over the
 * exact raw request body. Freshness is enforced to reject replayed requests.
 */
export function verifyRetellWebhookSignature(
  rawBody: string,
  apiKey: string,
  signature: string,
  nowMs = Date.now()
): boolean {
  if (!rawBody || !apiKey || !Number.isFinite(nowMs)) return false;
  const match = RETELL_SIGNATURE_PATTERN.exec(signature);
  if (!match) return false;

  const timestampMs = Number(match[1]);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(nowMs - timestampMs) > RETELL_SIGNATURE_MAX_AGE_MS
  ) {
    return false;
  }

  const expected = Buffer.from(
    computeRetellWebhookDigest(rawBody, apiKey, match[1]),
    "hex"
  );
  const supplied = Buffer.from(match[2], "hex");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function isVerifiedRetellRequest(
  req: Request,
  nowMs = Date.now()
): boolean {
  // Retell designates one API key specifically for webhook authentication.
  // Keep it distinct from the general REST API credential so rotation or a
  // wrong key assignment fails closed.
  const apiKey = process.env.RETELL_WEBHOOK_API_KEY || "";
  const rawBody = getRawJsonBody(req);
  const signature = req.get("x-retell-signature") || "";
  return (
    rawBody !== null &&
    verifyRetellWebhookSignature(rawBody, apiKey, signature, nowMs)
  );
}
