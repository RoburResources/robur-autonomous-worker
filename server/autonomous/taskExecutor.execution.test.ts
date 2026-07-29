import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDagReadyTask: vi.fn(),
  checkDagReadiness: vi.fn(),
  unlockDependents: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  isKillSwitchActive: vi.fn(),
  getDailyCallCount: vi.fn(),
  getDailyEmailCount: vi.fn(),
  upsertDailyMetrics: vi.fn(),
  getTodayMetrics: vi.fn(),
  updateTask: vi.fn(),
  logExecution: vi.fn(),
  getTaskById: vi.fn(),
  claimPendingTask: vi.fn(),
  updateClaimedTask: vi.fn(),
  requeueStaleInProgressTasks: vi.fn(),
  runPreflightValidation: vi.fn(),
  runPremortem: vi.fn(),
  verifyTaskOutcome: vi.fn(),
  validateTaskInput: vi.fn(),
  validateTaskOutput: vi.fn(),
  runCanaryExecution: vi.fn(),
  getTaskContext: vi.fn(),
  storeTaskOutcome: vi.fn(),
  storeContactInteraction: vi.fn(),
  getActiveExperiment: vi.fn(),
  assignVariant: vi.fn(),
  recordVariantOutcome: vi.fn(),
  isPrivateCandidateInternalAction: vi.fn(),
  isPrivateCandidateInternalOnly: vi.fn(),
  runGroundedWebResearch: vi.fn(),
  formatGroundedResearchSummary: vi.fn(),
}));

vi.mock("./dagEngine", () => ({
  getDagReadyTask: mocks.getDagReadyTask,
  checkDagReadiness: mocks.checkDagReadiness,
  unlockDependents: mocks.unlockDependents,
}));
vi.mock("../db", () => ({
  getConfig: mocks.getConfig,
  setConfig: mocks.setConfig,
  isKillSwitchActive: mocks.isKillSwitchActive,
  getDailyCallCount: mocks.getDailyCallCount,
  getDailyEmailCount: mocks.getDailyEmailCount,
  upsertDailyMetrics: mocks.upsertDailyMetrics,
  getTodayMetrics: mocks.getTodayMetrics,
  updateTask: mocks.updateTask,
  logExecution: mocks.logExecution,
  getTaskById: mocks.getTaskById,
  claimPendingTask: mocks.claimPendingTask,
  updateClaimedTask: mocks.updateClaimedTask,
  requeueStaleInProgressTasks: mocks.requeueStaleInProgressTasks,
}));
vi.mock("./preflightValidator", () => ({
  runPreflightValidation: mocks.runPreflightValidation,
}));
vi.mock("./premortem", () => ({ runPremortem: mocks.runPremortem }));
vi.mock("./verifier", () => ({ verifyTaskOutcome: mocks.verifyTaskOutcome }));
vi.mock("./schemaValidator", () => ({
  validateTaskInput: mocks.validateTaskInput,
  validateTaskOutput: mocks.validateTaskOutput,
}));
vi.mock("./canaryExecution", () => ({
  runCanaryExecution: mocks.runCanaryExecution,
}));
vi.mock("../memory/mem0", () => ({
  getTaskContext: mocks.getTaskContext,
  storeTaskOutcome: mocks.storeTaskOutcome,
  storeContactInteraction: mocks.storeContactInteraction,
}));
vi.mock("./abTesting", () => ({
  getActiveExperiment: mocks.getActiveExperiment,
  assignVariant: mocks.assignVariant,
  recordVariantOutcome: mocks.recordVariantOutcome,
}));
vi.mock("../safety/privateCandidatePolicy", () => ({
  isPrivateCandidateInternalAction: mocks.isPrivateCandidateInternalAction,
  isPrivateCandidateInternalOnly: mocks.isPrivateCandidateInternalOnly,
}));
vi.mock("../_core/webResearch", () => ({
  runGroundedWebResearch: mocks.runGroundedWebResearch,
  formatGroundedResearchSummary: mocks.formatGroundedResearchSummary,
}));
vi.mock("../_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("../integrations/retell", () => ({ makeOutboundCall: vi.fn() }));
vi.mock("../integrations/twilio", () => ({ sendSMS: vi.fn() }));
vi.mock("../integrations/sendgrid", () => ({
  sendEmail: vi.fn(),
  parseEmailDraft: vi.fn(),
  buildEmailTemplate: vi.fn(),
  isSendGridConfigured: vi.fn(),
}));

import { runTaskExecutor } from "./taskExecutor";

const task = {
  id: 42,
  goalId: null,
  source: "manual",
  description:
    "Research official Western Australian planning approval guidance for a commercial hardstand.",
  priorityScore: 100,
  status: "pending",
  assignedAgent: "autonomous_worker",
  actionType: "web_research",
  actionPayload: null,
  resultSummary: null,
  metadata: {},
  estimatedValue: null,
  completedAt: null,
  createdAt: new Date("2026-07-30T00:00:00Z"),
  updatedAt: new Date("2026-07-30T00:00:00Z"),
};

describe("task executor atomic owner-run path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isKillSwitchActive.mockResolvedValue(false);
    mocks.requeueStaleInProgressTasks.mockResolvedValue([]);
    mocks.updateTask.mockResolvedValue(undefined);
    mocks.updateClaimedTask.mockResolvedValue(true);
    mocks.logExecution.mockResolvedValue(undefined);
    mocks.upsertDailyMetrics.mockResolvedValue(undefined);
    mocks.unlockDependents.mockResolvedValue([]);
    mocks.storeTaskOutcome.mockResolvedValue(undefined);
    mocks.storeContactInteraction.mockResolvedValue(undefined);
    mocks.recordVariantOutcome.mockResolvedValue(undefined);
    mocks.getTodayMetrics.mockResolvedValue({ apiSpendCents: 0 });
    mocks.getDailyCallCount.mockResolvedValue(0);
    mocks.getDailyEmailCount.mockResolvedValue(0);
    mocks.getConfig.mockImplementation(async (key: string) => {
      const values: Record<string, string> = {
        max_api_spend_cents_per_day: "5000",
        max_calls_per_day: "20",
        max_emails_per_day: "100",
        approval_threshold_cents: "50000",
        external_contact_approval_required: "true",
      };
      return values[key] || null;
    });
    mocks.getTaskById.mockResolvedValue(task);
    mocks.checkDagReadiness.mockResolvedValue({
      isReady: true,
      blockedBy: [],
      blockedByDescriptions: [],
    });
    mocks.isPrivateCandidateInternalOnly.mockReturnValue(true);
    mocks.isPrivateCandidateInternalAction.mockReturnValue(true);
    mocks.validateTaskInput.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mocks.runPreflightValidation.mockResolvedValue({ canExecute: true });
    mocks.runPremortem.mockResolvedValue({
      confidenceScore: 0.95,
      shouldEscalate: false,
      failureModes: [],
    });
    mocks.validateTaskOutput.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mocks.verifyTaskOutcome.mockResolvedValue({
      verified: true,
      score: 0.95,
      verdict: "pass",
      reasoning: "Grounding and citations verified",
      recommendedAction: "accept",
      unintendedSideEffects: [],
    });
    mocks.getActiveExperiment.mockResolvedValue(null);
    mocks.runGroundedWebResearch.mockResolvedValue({
      text: "Two linked official findings.",
      sources: [
        { title: "Source one", url: "https://example.gov.au/one" },
        { title: "Source two", url: "https://example.gov.au/two" },
      ],
      model: "gpt-5.6-luna",
      responseId: "resp_test",
      webSearchCallCount: 1,
      attemptCount: 1,
    });
    mocks.formatGroundedResearchSummary.mockReturnValue(
      "findings: Two linked official findings.\n\nSources:\n1. https://example.gov.au/one\n2. https://example.gov.au/two"
    );
  });

  it("does not execute when another worker wins the atomic claim", async () => {
    mocks.claimPendingTask.mockResolvedValue(false);

    const result = await runTaskExecutor(task.id);

    expect(result).toMatchObject({
      executed: false,
      taskId: task.id,
      error: "Task was already claimed by another execution",
    });
    expect(mocks.runGroundedWebResearch).not.toHaveBeenCalled();
    expect(mocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        actionType: "task_execution_claim_lost",
        outcome: "partial",
      })
    );
  });

  it("durably records recovery of an expired execution lease", async () => {
    mocks.requeueStaleInProgressTasks.mockResolvedValue([41]);
    mocks.getTaskById.mockResolvedValue(null);

    const result = await runTaskExecutor(999);

    expect(result).toMatchObject({
      executed: false,
      error: "Requested task was not found",
    });
    expect(mocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 41,
        actionType: "task_execution_stale_claim_recovered",
        outcome: "partial",
      })
    );
  });

  it("executes the exact requested task once and records verified completion", async () => {
    mocks.claimPendingTask.mockResolvedValue(true);

    const result = await runTaskExecutor(task.id);

    expect(result).toEqual({
      executed: true,
      taskId: task.id,
      succeeded: true,
    });
    expect(mocks.getTaskById).toHaveBeenCalledWith(task.id);
    expect(mocks.claimPendingTask).toHaveBeenCalledWith(
      task.id,
      expect.any(String)
    );
    expect(mocks.runGroundedWebResearch).toHaveBeenCalledTimes(1);
    expect(mocks.updateClaimedTask).toHaveBeenCalledWith(
      task.id,
      expect.any(String),
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({
          output_schema_valid: true,
          grounded_research: expect.objectContaining({ attempt_count: 1 }),
          verification_result: expect.objectContaining({ verified: true }),
        }),
      })
    );
  });

  it("self-heals legacy JSON-string metadata before execution", async () => {
    const legacyMetadata = {
      roiScore: 6,
      phase: 1,
      requiresExternalContact: false,
      dependencies: [],
      dag_dependencies: [],
      category: "research",
    };
    mocks.getTaskById.mockResolvedValue({
      ...task,
      metadata: JSON.stringify(legacyMetadata),
    });
    mocks.claimPendingTask.mockResolvedValue(true);

    await expect(runTaskExecutor(task.id)).resolves.toEqual({
      executed: true,
      taskId: task.id,
      succeeded: true,
    });

    expect(mocks.checkDagReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: legacyMetadata })
    );
    expect(mocks.runPreflightValidation).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: legacyMetadata })
    );

    const finalUpdate = mocks.updateClaimedTask.mock.calls[0][2];
    expect(finalUpdate.metadata).toEqual(
      expect.objectContaining({
        ...legacyMetadata,
        output_schema_valid: true,
      })
    );
    expect(
      Object.keys(finalUpdate.metadata).some(key => /^\d+$/.test(key))
    ).toBe(false);
  });

  it("does not complete research on a contradictory partial retry verdict", async () => {
    mocks.claimPendingTask.mockResolvedValue(true);
    mocks.verifyTaskOutcome.mockResolvedValue({
      verified: true,
      score: 0.9,
      verdict: "partial",
      reasoning: "The research needs another attempt",
      recommendedAction: "retry",
      unintendedSideEffects: [],
    });

    await expect(runTaskExecutor(task.id)).resolves.toEqual({
      executed: true,
      taskId: task.id,
      succeeded: false,
      error: expect.stringContaining("Research verification did not pass"),
    });
    expect(mocks.updateClaimedTask).toHaveBeenCalledWith(
      task.id,
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({
          verification_result: expect.objectContaining({
            verdict: "partial",
            recommendedAction: "retry",
          }),
        }),
      })
    );
  });

  it("discards a stale result when its fencing token no longer owns the task", async () => {
    mocks.claimPendingTask.mockResolvedValue(true);
    mocks.updateClaimedTask.mockResolvedValue(false);

    const result = await runTaskExecutor(task.id);

    expect(result).toMatchObject({
      executed: false,
      taskId: task.id,
      error: "Execution claim expired; stale result discarded",
    });
    expect(mocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        actionType: "task_execution_stale_result_discarded",
        outcome: "partial",
      })
    );
    expect(mocks.recordVariantOutcome).not.toHaveBeenCalled();
    expect(mocks.unlockDependents).not.toHaveBeenCalled();
  });
});
