import { getConfig } from "../db";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

export interface PreflightResult {
  canExecute: boolean;
  blockedReason?: string;
  missingCredentials?: string[];
  warnings?: string[];
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
    // Email sending requires SMTP or Make.com webhook
    const emailWebhook = await getConfig("email_webhook_url");
    if (!emailWebhook) {
      warnings.push("No email webhook configured — email will be drafted only, not sent");
    }
  }

  // ── 3. Check task has minimum required data ───────────────────────────────
  if (!task.description || task.description.trim().length < 10) {
    issues.push("Task description too short or missing");
  }

  // ── 4. Check dependency blockers from metadata ────────────────────────────
  const meta = task.metadata as any;
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
  const maxApiSpendCents = parseInt(await getConfig("max_api_spend_cents_per_day") || "5000");
  const maxCalls = parseInt(await getConfig("max_calls_per_day") || "20");
  const maxEmails = parseInt(await getConfig("max_emails_per_day") || "100");

  // These are checked again in executor but we validate config is sane
  if (maxApiSpendCents <= 0) issues.push("Invalid max_api_spend_cents_per_day config");
  if (maxCalls <= 0) issues.push("Invalid max_calls_per_day config");
  if (maxEmails <= 0) issues.push("Invalid max_emails_per_day config");

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
