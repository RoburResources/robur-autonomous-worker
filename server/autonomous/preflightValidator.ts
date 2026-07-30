import { getConfig } from "../db";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { normalizeTaskMetadata } from "./taskMetadata";

export interface PreflightResult {
  canExecute: boolean;
  blockedReason?: string;
  missingCredentials?: string[];
  warnings?: string[];
}

export function parsePositiveIntegerLimit(
  rawValue: string | null | undefined,
  fallback: number
): number | null {
  if (!Number.isSafeInteger(fallback) || fallback <= 0) {
    throw new Error("Limit fallback must be a positive safe integer");
  }
  const normalized =
    rawValue === null || rawValue === undefined
      ? String(fallback)
      : rawValue.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Pre-flight validation gate — checks before any task executes:
 * - Required credentials/tools are available
 * - Daily limits not exceeded
 * - Dependencies are met
 * - Task has necessary data to proceed
 */
export async function runPreflightValidation(task: any): Promise<PreflightResult> {
  const issues: string[] = [];
  const warnings: string[] = [];

  // ── 1. Check kill switch ──────────────────────────────────────────────────
  const gate = await getLegacyWorkerRuntimeGate();
  if (!gate.allowed) {
    return { canExecute: false, blockedReason: gate.reason || "Legacy worker is unavailable" };
  }

  // ── 2. Check credential availability per action type ─────────────────────
  const actionType = task.actionType || "";

  if (actionType === "outbound_call") {
    const retellKey = process.env.RETELL_API_KEY;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
    if (!retellKey) issues.push("RETELL_API_KEY not configured");
    if (!twilioPhone) issues.push("TWILIO_PHONE_NUMBER not configured");
  }

  if (actionType === "send_sms") {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
    if (!twilioSid) issues.push("TWILIO_ACCOUNT_SID not configured");
    if (!twilioAuth) issues.push("TWILIO_AUTH_TOKEN not configured");
    if (!twilioPhone) issues.push("TWILIO_PHONE_NUMBER not configured");
  }

  if (actionType === "send_email") {
    const payload = normalizeTaskMetadata(task.actionPayload);
    const metadata = normalizeTaskMetadata(task.metadata);
    const recipient =
      (typeof payload.email === "string" && payload.email.trim()) ||
      (typeof metadata.recipientEmail === "string" &&
        metadata.recipientEmail.trim()) ||
      "";
    if (recipient && !process.env.SENDGRID_API_KEY) {
      issues.push("SENDGRID_API_KEY not configured");
    } else if (!recipient) {
      warnings.push("No email recipient configured — email will remain a draft");
    }
  }

  // ── 3. Check task has minimum required data ───────────────────────────────
  if (!task.description || task.description.trim().length < 10) {
    issues.push("Task description too short or missing");
  }

  // ── 4. Check dependency blockers from metadata ────────────────────────────
  const meta = normalizeTaskMetadata(task.metadata);
  if (meta?.blocker) {
    return { canExecute: false, blockedReason: `Task blocked: ${meta.blocker}` };
  }

  if (meta?.dependencies && Array.isArray(meta.dependencies) && meta.dependencies.length > 0) {
    const unmetDeps: string[] = [];
    for (const dep of meta.dependencies) {
      const depStatus = await getConfig(`dependency_${dep}`);
      if (depStatus !== "complete" && depStatus !== "true") {
        unmetDeps.push(dep);
      }
    }
    if (unmetDeps.length > 0) {
      return {
        canExecute: false,
        blockedReason: `Unmet dependencies: ${unmetDeps.join(", ")}`,
      };
    }
  }

  // ── 5. Check hard limits ──────────────────────────────────────────────────
  const maxApiSpendCents = parsePositiveIntegerLimit(
    await getConfig("max_api_spend_cents_per_day"),
    5000
  );
  const maxCalls = parsePositiveIntegerLimit(
    await getConfig("max_calls_per_day"),
    20
  );
  const maxEmails = parsePositiveIntegerLimit(
    await getConfig("max_emails_per_day"),
    100
  );

  // These are checked again in executor but we validate config is sane
  if (maxApiSpendCents === null)
    issues.push("Invalid max_api_spend_cents_per_day config");
  if (maxCalls === null) issues.push("Invalid max_calls_per_day config");
  if (maxEmails === null) issues.push("Invalid max_emails_per_day config");

  // ── 6. Result ─────────────────────────────────────────────────────────────
  if (issues.length > 0) {
    return {
      canExecute: false,
      blockedReason: `Pre-flight failed: ${issues.join("; ")}`,
      missingCredentials: issues,
      warnings,
    };
  }

  return { canExecute: true, warnings: warnings.length > 0 ? warnings : undefined };
}
