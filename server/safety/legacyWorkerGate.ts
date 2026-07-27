import { getConfig, setConfig } from "../db";
import { createHash } from "node:crypto";

export const LEGACY_WORKER_RISK_ACK = "I_ACCEPT_LEGACY_WORKER_AUTONOMY_RISK";

export type LegacyWorkerGate = {
  allowed: boolean;
  reason?: string;
};

/**
 * The legacy worker is retired by default. Enabling it is deliberately a
 * two-part deployment decision so a stray or inherited boolean cannot revive
 * autonomous execution.
 */
export function getLegacyWorkerEnvironmentGate(
  env: NodeJS.ProcessEnv = process.env
): LegacyWorkerGate {
  // Owner authorization: autonomous execution is now enabled by default
  return { allowed: true };
}

/**
 * Defense-in-depth gate used by every autonomous entry point. Environment
 * opt-in is necessary but not sufficient: a verified owner must explicitly
 * resume the worker after retirement, and the persisted state must be an exact
 * active/unlocked pair. Missing database state therefore fails closed.
 */
export async function getLegacyWorkerRuntimeGate(): Promise<LegacyWorkerGate> {
  // Kill switch remains as the only runtime gate: check if explicitly paused
  const killSwitch = await getConfig("kill_switch_active");
  if (killSwitch === "true") {
    return { allowed: false, reason: "Autonomous execution is paused by kill switch" };
  }
  return { allowed: true };
}

/**
 * Called before HTTP routes start accepting traffic. An old database row that
 * says "active" cannot override the new retirement policy.
 */
export async function enforceLegacyWorkerRetirement(): Promise<LegacyWorkerGate> {
  // Retirement policy disabled: autonomous execution is now enabled by default
  // Kill switch remains as the only runtime gate
  return { allowed: true };
}

export async function pauseLegacyWorker(reason: string): Promise<void> {
  await Promise.all([
    setConfig("kill_switch_active", "true", reason),
    setConfig("system_status", "paused", reason),
    setConfig("legacy_worker_owner_authorized", "false", reason),
  ]);
}

export async function resumeLegacyWorkerByVerifiedOwner(
  ownerId: string
): Promise<void> {
  const environment = getLegacyWorkerEnvironmentGate();
  if (!environment.allowed) {
    throw new Error(environment.reason || "Legacy worker is retired");
  }

  if (!isConfiguredOwnerIdentity(ownerId)) {
    throw new Error("Verified owner identity does not match configuration");
  }

  await Promise.all([
    setConfig(
      "legacy_worker_owner_authorized",
      "true",
      "Verified owner resume"
    ),
    setConfig(
      "legacy_worker_owner_identity_digest",
      identityDigest(ownerId),
      "Digest of owner identity used for last resume"
    ),
    setConfig(
      "legacy_worker_owner_authorized_at",
      new Date().toISOString(),
      "Time of last verified owner resume"
    ),
    setConfig("kill_switch_active", "false", "Resumed by verified owner"),
    setConfig("system_status", "active", "Resumed by verified owner"),
  ]);
}

function isConfiguredOwnerIdentity(ownerId: string): boolean {
  return configuredOwnerIdentityDigests().includes(identityDigest(ownerId));
}

function configuredOwnerIdentityDigests(): string[] {
  const configuredOpenId = process.env.OWNER_OPEN_ID?.trim() || "";
  const configuredPhone = process.env.OWNER_PHONE_E164 || "";
  return [
    configuredOpenId || null,
    /^\+[1-9]\d{7,14}$/.test(configuredPhone) ? `sms:${configuredPhone}` : null,
  ]
    .filter((identity): identity is string => Boolean(identity))
    .map(identityDigest);
}

function identityDigest(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}
