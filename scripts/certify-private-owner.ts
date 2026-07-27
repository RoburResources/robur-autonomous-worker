import { upsertUser } from "../server/db";
import { sdk } from "../server/_core/sdk";
import { privateCandidateInternalAutonomyEnabled } from "../server/safety/privateCandidatePolicy";

const EXPECTED_PROJECT_ID = "c27db74c-5419-4c45-a403-1fafeba56829";
const EXPECTED_ENVIRONMENT_ID = "894781b5-86ed-4df3-9f42-1393320bd857";
const EXPECTED_SERVICE_ID = "31c607a8-09b6-40b1-955a-f952571c3e0d";

function requireExact(name: string, actual: string | undefined, expected: string) {
  if (actual !== expected) {
    throw new Error(`${name} does not match the authorised private candidate`);
  }
}

async function main(): Promise<void> {
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
  if (!process.env.JWT_SECRET) throw new Error("Session signing secret is missing");
  if (!process.env.VITE_APP_ID) throw new Error("Private application identity is missing");

  await upsertUser({
    openId: ownerId,
    name: "Michael",
    role: "admin",
    loginMethod: "private_candidate",
    lastSignedIn: new Date(),
  });

  process.env.PRIVATE_OWNER_SESSION = await sdk.createSessionToken(ownerId, {
    expiresInMs: 5 * 60 * 1000,
    name: "Michael",
  });
  process.env.PRIVATE_CANDIDATE_URL = "http://127.0.0.1:8080";
  process.env.EXPECT_INTERNAL_AUTONOMY = "true";

  await import("./verify-private-candidate");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
