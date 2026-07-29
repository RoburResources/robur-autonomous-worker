import {
  formatGroundedResearchSummary,
  runGroundedWebResearch,
} from "../server/_core/webResearch";
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

  const result = await runGroundedWebResearch(
    "Find two official Western Australian government sources that explain planning or development approval requirements relevant to a commercial hardstand in metropolitan Perth. State only what those sources support and identify what still requires site-specific verification."
  );
  const summary = formatGroundedResearchSummary(result);

  console.log(
    JSON.stringify({
      certified:
        result.sources.length >= 2 &&
        result.webSearchCallCount >= 1 &&
        summary.includes("Sources:"),
      model: result.model,
      sourceCount: result.sources.length,
      webSearchCallCount: result.webSearchCallCount,
      summaryLength: summary.length,
    })
  );
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
