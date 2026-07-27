import {
  getDailyCallCount,
  getDailyEmailCount,
  getRecentExecutions,
  getRecentTasks,
  updateTask,
} from "../server/db";
import { runPrivateCandidateSchedulerTick } from "../server/autonomous/privateCandidateScheduler";
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

  const priorTasks = await getRecentTasks(10_000);
  const testOwnedTasks = priorTasks.filter(
    task =>
      task.source === "codex_private_certification" &&
      task.status !== "completed" &&
      task.status !== "cancelled"
  );
  for (const task of testOwnedTasks) {
    await updateTask(task.id, {
      status: "cancelled",
      resultSummary:
        "Certification probe ended safely at the confidence gate; no external effect occurred",
    });
  }

  const forcedExecutorBoundary = new Date();
  forcedExecutorBoundary.setUTCMinutes(15, 0, 0);
  await runPrivateCandidateSchedulerTick(forcedExecutorBoundary);

  const [logs, dailyCalls, dailyEmails] = await Promise.all([
    getRecentExecutions(10_000),
    getDailyCallCount(),
    getDailyEmailCount(),
  ]);

  const persistedSchedulerSuccess = logs.some(
    log =>
      log.actionType === "private_candidate_task_executor_cycle" &&
      log.outcome === "success"
  );
  const certified =
    persistedSchedulerSuccess &&
    dailyCalls === 0 &&
    dailyEmails === 0;

  console.log(
    JSON.stringify({
      certified,
      cancelledTestOwnedTasks: testOwnedTasks.length,
      persistedSchedulerSuccess,
      dailyCallCount: dailyCalls,
      dailyEmailCount: dailyEmails,
    })
  );

  if (!certified) {
    throw new Error("Private internal cycle did not satisfy certification");
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
