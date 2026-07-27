import {
  getLegacyWorkerRuntimeGate,
  resumeLegacyWorkerByVerifiedOwner,
} from "../server/safety/legacyWorkerGate";
import { getConfig } from "../server/db";
import { privateCandidateInternalAutonomyEnabled } from "../server/safety/privateCandidatePolicy";

const EXPECTED_PROJECT_ID = "c27db74c-5419-4c45-a403-1fafeba56829";
const EXPECTED_ENVIRONMENT_ID = "894781b5-86ed-4df3-9f42-1393320bd857";
const EXPECTED_SERVICE_ID = "31c607a8-09b6-40b1-955a-f952571c3e0d";

function requireExact(name: string, actual: string | undefined, expected: string) {
  if (actual !== expected) {
    throw new Error(`${name} does not match the authorised private candidate`);
  }
}

requireExact("RAILWAY_PROJECT_ID", process.env.RAILWAY_PROJECT_ID, EXPECTED_PROJECT_ID);
requireExact(
  "RAILWAY_ENVIRONMENT_ID",
  process.env.RAILWAY_ENVIRONMENT_ID,
  EXPECTED_ENVIRONMENT_ID
);
requireExact("RAILWAY_SERVICE_ID", process.env.RAILWAY_SERVICE_ID, EXPECTED_SERVICE_ID);

if (!privateCandidateInternalAutonomyEnabled()) {
  throw new Error("Private-candidate internal-only autonomy flags are not enabled");
}

const ownerId = process.env.OWNER_OPEN_ID?.trim();
if (!ownerId) throw new Error("Configured owner identity is missing");

await resumeLegacyWorkerByVerifiedOwner(ownerId);

const [killSwitch, status, ownerAuthorized, runtimeGate] = await Promise.all([
  getConfig("kill_switch_active"),
  getConfig("system_status"),
  getConfig("legacy_worker_owner_authorized"),
  getLegacyWorkerRuntimeGate(),
]);

const activated =
  killSwitch === "false" &&
  status === "active" &&
  ownerAuthorized === "true" &&
  runtimeGate.allowed;

console.log(
  JSON.stringify({
    activated,
    internalOnly: true,
    killSwitchActive: killSwitch,
    systemStatus: status,
    ownerAuthorized,
    autonomousExecution: runtimeGate.allowed,
  })
);

if (!activated) {
  throw new Error("Private candidate did not enter the expected internal-only state");
}
