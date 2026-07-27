import {
  getDailyCallCount,
  getDailyEmailCount,
  getRecentExecutions,
  getRecentTasks,
} from "../server/db";
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

  const [tasks, executions, dailyCalls, dailyEmails] = await Promise.all([
    getRecentTasks(10_000),
    getRecentExecutions(10_000),
    getDailyCallCount(),
    getDailyEmailCount(),
  ]);

  const externalExecutionTypes = new Set([
    "outbound_call",
    "send_sms",
    "send_email",
    "approval_request",
    "external_contact_approval_request",
  ]);
  const externalExecutions = executions.filter(entry =>
    externalExecutionTypes.has(entry.actionType)
  );

  const taskStatusCounts = tasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] || 0) + 1;
    return counts;
  }, {});
  const taskActionCounts = tasks.reduce<Record<string, number>>((counts, task) => {
    const action = task.actionType || "unknown";
    counts[action] = (counts[action] || 0) + 1;
    return counts;
  }, {});

  const audit = {
    safe: externalExecutions.length === 0 && dailyCalls === 0 && dailyEmails === 0,
    taskCount: tasks.length,
    executionCount: executions.length,
    taskStatusCounts,
    taskActionCounts,
    externalExecutionCount: externalExecutions.length,
    dailyCallCount: dailyCalls,
    dailyEmailCount: dailyEmails,
  };

  console.log(JSON.stringify(audit));
  if (!audit.safe) {
    throw new Error("Private-candidate audit found an external-effect outcome");
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
