import { getConfig, setConfigsAtomically } from "../db";
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
  if (env.LEGACY_WORKER_ENABLED !== "true") {
    return {
      allowed: false,
      reason: "Legacy worker deployment opt-in is not enabled",
    };
  }

  if (env.LEGACY_WORKER_RISK_ACK !== LEGACY_WORKER_RISK_ACK) {
    return {
      allowed: false,
      reason: "Legacy worker risk acknowledgement is missing or invalid",
    };
  }

  if (configuredOwnerIdentityDigests(env).length === 0) {
    return {
      allowed: false,
      reason: "No valid verified owner identity is configured",
    };
  }

  return { allowed: true };
}

/**
 * Defense-in-depth gate used by every autonomous entry point. Environment
 * opt-in is necessary but not sufficient: a verified owner must explicitly
 * resume the worker after retirement, and the persisted state must be an exact
 * active/unlocked pair. Missing database state therefore fails closed.
 */
export async function getLegacyWorkerRuntimeGate(
  env: NodeJS.ProcessEnv = process.env
): Promise<LegacyWorkerGate> {
  const environment = getLegacyWorkerEnvironmentGate(env);
  if (!environment.allowed) {
    return environment;
  }

  const [killSwitch, systemStatus, ownerAuthorized, ownerIdentityDigest] =
    await Promise.all([
      getConfig("kill_switch_active"),
      getConfig("system_status"),
      getConfig("legacy_worker_owner_authorized"),
      getConfig("legacy_worker_owner_identity_digest"),
    ]);

  if (killSwitch !== "false") {
    return {
      allowed: false,
      reason: "Autonomous execution is paused by kill switch",
    };
  }
  if (systemStatus !== "active") {
    return {
      allowed: false,
      reason: "Autonomous execution requires exact active system status",
    };
  }
  if (ownerAuthorized !== "true") {
    return {
      allowed: false,
      reason: "Autonomous execution has not been resumed by a verified owner",
    };
  }
  if (
    !ownerIdentityDigest ||
    !configuredOwnerIdentityDigests(env).includes(ownerIdentityDigest)
  ) {
    return {
      allowed: false,
      reason: "Stored owner authorization does not match configured owner",
    };
  }

  return { allowed: true };
}

/**
 * Called before HTTP routes start accepting traffic. An old database row that
 * says "active" cannot override the new retirement policy.
 */
export async function enforceLegacyWorkerRetirement(): Promise<LegacyWorkerGate> {
  const environment = getLegacyWorkerEnvironmentGate();
  if (!environment.allowed) {
    const reason = environment.reason || "Legacy worker is retired";
    await setConfigsAtomically([
      { key: "kill_switch_active", value: "true", description: reason },
      { key: "system_status", value: "retired", description: reason },
      {
        key: "legacy_worker_owner_authorized",
        value: "false",
        description: reason,
      },
    ]);
    return environment;
  }

  return getLegacyWorkerRuntimeGate();
}

export async function pauseLegacyWorker(reason: string): Promise<void> {
  await setConfigsAtomically([
    { key: "kill_switch_active", value: "true", description: reason },
    { key: "system_status", value: "paused", description: reason },
    {
      key: "legacy_worker_owner_authorized",
      value: "false",
      description: reason,
    },
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

  await setConfigsAtomically([
    {
      key: "legacy_worker_owner_authorized",
      value: "true",
      description: "Verified owner resume",
    },
    {
      key: "legacy_worker_owner_identity_digest",
      value: identityDigest(ownerId),
      description: "Digest of owner identity used for last resume",
    },
    {
      key: "legacy_worker_owner_authorized_at",
      value: new Date().toISOString(),
      description: "Time of last verified owner resume",
    },
    {
      key: "kill_switch_active",
      value: "false",
      description: "Resumed by verified owner",
    },
    {
      key: "system_status",
      value: "active",
      description: "Resumed by verified owner",
    },
  ]);
}

function isConfiguredOwnerIdentity(ownerId: string): boolean {
  return configuredOwnerIdentityDigests().includes(identityDigest(ownerId));
}

function configuredOwnerIdentityDigests(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const configuredOpenId = env.OWNER_OPEN_ID?.trim() || "";
  const configuredPhone = env.OWNER_PHONE_E164?.trim() || "";
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
