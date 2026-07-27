import { runEvaluator } from "./evaluator";
import { runSelfImprover } from "./selfImprover";
import { runTaskExecutor } from "./taskExecutor";
import { runTaskGenerator } from "./taskGenerator";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { privateCandidateInternalAutonomyEnabled } from "../safety/privateCandidatePolicy";

export type PrivateCandidateJob =
  | "task-generator"
  | "task-executor"
  | "evaluator"
  | "self-improver";

const lastRunSlots = new Map<PrivateCandidateJob, string>();
let tickInFlight = false;

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

async function runJob(job: PrivateCandidateJob): Promise<void> {
  if (job === "task-generator") await runTaskGenerator();
  else if (job === "task-executor") await runTaskExecutor();
  else if (job === "evaluator") await runEvaluator();
  else await runSelfImprover();
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
      try {
        await runJob(job);
        console.log(`[Private Candidate] Completed internal ${job} cycle`);
      } catch (error) {
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
