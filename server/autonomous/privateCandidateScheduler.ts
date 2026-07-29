import { runEvaluator } from "./evaluator";
import { runSelfImprover } from "./selfImprover";
import { runTaskExecutor } from "./taskExecutor";
import { runTaskGenerator } from "./taskGenerator";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { privateCandidateInternalAutonomyEnabled } from "../safety/privateCandidatePolicy";
import { claimPrivateCandidateJobSlot, logExecution } from "../db";

export type PrivateCandidateJob =
  | "task-generator"
  | "task-executor"
  | "evaluator"
  | "self-improver";

const lastRunSlots = new Map<PrivateCandidateJob, string>();
let tickInFlight = false;
const MAX_SCHEDULER_ERROR_LENGTH = 1_000;

function boundedSchedulerError(value: string | undefined): string | undefined {
  const message = value?.trim();
  if (!message || message.length <= MAX_SCHEDULER_ERROR_LENGTH) {
    return message;
  }
  const suffix = "… [truncated]";
  return `${message.slice(0, MAX_SCHEDULER_ERROR_LENGTH - suffix.length)}${suffix}`;
}

export function getPrivateCandidateDueJobs(now: Date): PrivateCandidateJob[] {
  const minute = now.getUTCMinutes();
  const hour = now.getUTCHours();
  const jobs: PrivateCandidateJob[] = [];

  if (minute === 0) jobs.push("task-generator");
  if (minute % 15 === 0) jobs.push("task-executor");
  if (hour === 10 && minute === 0) jobs.push("evaluator");
  if (now.getUTCDay() === 0 && hour === 14 && minute === 0) {
    jobs.push("self-improver");
  }

  return jobs;
}

function slotFor(job: PrivateCandidateJob, now: Date): string {
  const isoMinute = now.toISOString().slice(0, 16);
  if (job === "task-executor") return isoMinute;
  if (job === "task-generator") return isoMinute.slice(0, 13);
  return isoMinute.slice(0, 10);
}

async function runJob(job: PrivateCandidateJob, slot: string): Promise<void> {
  let generatorResult:
    | {
        tasksCreated: number;
        error?: string;
      }
    | undefined;
  let executorResult:
    | {
        executed: boolean;
        taskId?: number;
        succeeded?: boolean;
        error?: string;
      }
    | undefined;
  if (job === "task-generator") generatorResult = await runTaskGenerator();
  else if (job === "task-executor") executorResult = await runTaskExecutor();
  else if (job === "evaluator") await runEvaluator();
  else await runSelfImprover();

  const executorIdle =
    executorResult?.executed === false &&
    executorResult.error === "No DAG-ready pending tasks";
  const executorBlocked =
    executorResult?.executed === false &&
    !executorIdle;
  const executorFailed =
    executorResult?.executed === true &&
    executorResult.succeeded === false;
  const executorError = boundedSchedulerError(executorResult?.error);
  const generatorIdle =
    generatorResult?.tasksCreated === 0 &&
    (
      !generatorResult.error ||
      generatorResult.error === "No active goals" ||
      generatorResult.error.startsWith("Queue already has ")
    );
  const generatorFailed =
    Boolean(generatorResult?.error) && !generatorIdle;
  const generatorError = boundedSchedulerError(generatorResult?.error);
  const jobFailed = executorBlocked || executorFailed || generatorFailed;
  await logExecution({
    actionType: `private_candidate_${job.replace("-", "_")}_cycle`,
    details: {
      job,
      slot,
      containment: "internal-only",
      ...(executorResult
        ? {
            executed: executorResult.executed,
            succeeded: executorResult.succeeded,
            taskId: executorResult.taskId,
            error: executorError,
            idle: executorIdle,
          }
        : {}),
      ...(generatorResult
        ? {
            tasksCreated: generatorResult.tasksCreated,
            error: generatorError,
            idle: generatorIdle,
          }
        : {}),
      completedAt: new Date().toISOString(),
    },
    outcome: jobFailed ? "partial" : "success",
    errorMessage: jobFailed ? executorError || generatorError : undefined,
  });
}

export async function runPrivateCandidateSchedulerTick(
  now = new Date()
): Promise<void> {
  if (!privateCandidateInternalAutonomyEnabled() || tickInFlight) return;

  tickInFlight = true;
  try {
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) return;

    for (const job of getPrivateCandidateDueJobs(now)) {
      const slot = slotFor(job, now);
      if (lastRunSlots.get(job) === slot) continue;
      lastRunSlots.set(job, slot);
      if (!(await claimPrivateCandidateJobSlot(job, slot))) {
        console.log(
          `[Private Candidate] Skipped already-claimed ${job} slot ${slot}`
        );
        continue;
      }
      try {
        await runJob(job, slot);
        console.log(`[Private Candidate] Completed internal ${job} cycle`);
      } catch (error) {
        const message = boundedSchedulerError(
          error instanceof Error ? error.message : "Unknown scheduler failure"
        );
        await logExecution({
          actionType: `private_candidate_${job.replace("-", "_")}_cycle`,
          details: {
            job,
            slot,
            containment: "internal-only",
            completedAt: new Date().toISOString(),
          },
          outcome: "failure",
          errorMessage: message || "Unknown scheduler failure",
        }).catch(logError => {
          console.error(
            `[Private Candidate] Could not persist ${job} failure`,
            logError
          );
        });
        console.error(`[Private Candidate] Internal ${job} cycle failed`, error);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

export function startPrivateCandidateScheduler(): void {
  if (!privateCandidateInternalAutonomyEnabled()) {
    console.log("[Private Candidate] Internal scheduler disabled");
    return;
  }

  console.log(
    "[Private Candidate] Internal-only scheduler enabled; external actions remain blocked"
  );
  void runPrivateCandidateSchedulerTick();
  const timer = setInterval(() => {
    void runPrivateCandidateSchedulerTick();
  }, 30_000);
  timer.unref();
}
