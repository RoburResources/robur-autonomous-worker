import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
  getActiveGoals: vi.fn(),
  getTasksByStatus: vi.fn(),
  getRecentTasks: vi.fn(),
  getRecentMetrics: vi.fn(),
  getOpportunities: vi.fn(),
  logExecution: vi.fn(),
  getConfig: vi.fn(),
  createTaskOnce: vi.fn(),
  getLegacyWorkerRuntimeGate: vi.fn(),
}));

vi.mock("../_core/llm", () => ({ invokeLLM: mocks.invokeLLM }));
vi.mock("../db", () => ({
  getActiveGoals: mocks.getActiveGoals,
  getTasksByStatus: mocks.getTasksByStatus,
  getRecentTasks: mocks.getRecentTasks,
  getRecentMetrics: mocks.getRecentMetrics,
  getOpportunities: mocks.getOpportunities,
  logExecution: mocks.logExecution,
  getConfig: mocks.getConfig,
  createTaskOnce: mocks.createTaskOnce,
}));
vi.mock("../safety/legacyWorkerGate", () => ({
  getLegacyWorkerRuntimeGate: mocks.getLegacyWorkerRuntimeGate,
}));

import { runEveningBriefing, runMorningBriefing } from "./briefings";

describe("scheduled briefings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OWNER_PHONE_E164;
    mocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    mocks.getActiveGoals.mockResolvedValue([]);
    mocks.getTasksByStatus.mockResolvedValue([]);
    mocks.getRecentMetrics.mockResolvedValue([]);
    mocks.getOpportunities.mockResolvedValue([]);
    mocks.getConfig.mockResolvedValue("+61400000000");
    mocks.createTaskOnce.mockResolvedValue({ created: true });
    mocks.logExecution.mockResolvedValue(undefined);
    mocks.invokeLLM.mockResolvedValue({
      choices: [{ message: { content: "Exact owner briefing script." } }],
    });
  });

  it.each([
    ["morning", runMorningBriefing],
    ["evening", runEveningBriefing],
  ] as const)(
    "queues the %s script through exact-artifact approval instead of calling a provider",
    async (briefingType, runBriefing) => {
      await expect(runBriefing()).resolves.toEqual({ success: true });

      expect(mocks.createTaskOnce).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^scheduled_briefing:${briefingType}:\\d{4}-\\d{2}-\\d{2}$`)
        ),
        expect.objectContaining({
          source: "scheduled_briefing",
          actionType: "outbound_call",
          actionPayload: {
            phoneNumber: "+61400000000",
            script: "Exact owner briefing script.",
          },
          metadata: expect.objectContaining({
            briefing_type: briefingType,
            exact_script_required: true,
          }),
        })
      );
      expect(mocks.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: `${briefingType}_briefing_queued`,
          outcome: "pending",
          details: expect.objectContaining({
            exactArtifactApprovalRequired: true,
          }),
        })
      );
    }
  );

  it("treats a duplicate schedule trigger as the same briefing slot", async () => {
    mocks.createTaskOnce
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false });

    await runMorningBriefing();
    await runMorningBriefing();

    const firstKey = mocks.createTaskOnce.mock.calls[0][0];
    const secondKey = mocks.createTaskOnce.mock.calls[1][0];
    expect(secondKey).toBe(firstKey);
    expect(mocks.logExecution).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionType: "morning_briefing_already_queued",
        outcome: "success",
      })
    );
  });
});
