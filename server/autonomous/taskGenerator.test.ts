import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
  getActiveGoals: vi.fn(),
  createTask: vi.fn(),
  getConfig: vi.fn(),
  getAllConfig: vi.fn(),
  getRecentTasks: vi.fn(),
  logExecution: vi.fn(),
  updateTask: vi.fn(),
  linkBatchDependencies: vi.fn(),
  searchMemories: vi.fn(),
  getLegacyWorkerRuntimeGate: vi.fn(),
  isPrivateCandidateInternalOnly: vi.fn(),
}));

vi.mock("../_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
}));
vi.mock("../db", () => ({
  getActiveGoals: mocks.getActiveGoals,
  createTask: mocks.createTask,
  getConfig: mocks.getConfig,
  getAllConfig: mocks.getAllConfig,
  getRecentTasks: mocks.getRecentTasks,
  logExecution: mocks.logExecution,
  updateTask: mocks.updateTask,
}));
vi.mock("./dependencyLinker", () => ({
  linkBatchDependencies: mocks.linkBatchDependencies,
}));
vi.mock("../memory/mem0", () => ({
  searchMemories: mocks.searchMemories,
}));
vi.mock("../safety/legacyWorkerGate", () => ({
  getLegacyWorkerRuntimeGate: mocks.getLegacyWorkerRuntimeGate,
}));
vi.mock("../safety/privateCandidatePolicy", () => ({
  isPrivateCandidateInternalOnly: mocks.isPrivateCandidateInternalOnly,
}));

import { runTaskGenerator } from "./taskGenerator";

describe("task generator metadata persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    mocks.getActiveGoals.mockResolvedValue([
      {
        id: 1,
        priority: 10,
        goalText: "Research private operational opportunities",
        subGoals: [],
      },
    ]);
    mocks.getRecentTasks.mockResolvedValue([]);
    mocks.getConfig.mockImplementation(async (key: string) => {
      const values: Record<string, string> = {
        task_generation_model: "gpt-4o-mini",
        max_tasks_per_generation_cycle: "5",
        min_internal_task_ratio: "0.6",
        external_contact_approval_required: "true",
      };
      return values[key] || "";
    });
    mocks.searchMemories.mockResolvedValue([]);
    mocks.isPrivateCandidateInternalOnly.mockReturnValue(true);
    mocks.createTask.mockResolvedValue([{ insertId: 101 }]);
    mocks.linkBatchDependencies.mockResolvedValue([]);
    mocks.updateTask.mockResolvedValue(undefined);
    mocks.logExecution.mockResolvedValue(undefined);
    mocks.invokeLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tasks: [
                {
                  description:
                    "Research official Western Australian recovery-market guidance.",
                  actionType: "data_entry",
                  priorityScore: 91,
                  estimatedValue: 5000,
                  goalId: 1,
                  roiScore: 8,
                  phase: 1,
                  requiresExternalContact: false,
                  dependencies: [],
                  category: "research",
                },
              ],
            }),
          },
        },
      ],
      usage: { total_tokens: 125 },
    });
  });

  it("writes a JSON object and keeps private tasks internal-only", async () => {
    await expect(runTaskGenerator()).resolves.toEqual({ tasksCreated: 1 });

    expect(mocks.createTask).toHaveBeenCalledOnce();
    const insertedTask = mocks.createTask.mock.calls[0][0];

    expect(insertedTask.actionType).toBe("web_research");
    expect(typeof insertedTask.metadata).toBe("object");
    expect(insertedTask.metadata).toEqual({
      roiScore: 8,
      phase: 1,
      requiresExternalContact: false,
      dependencies: [],
      dag_dependencies: [],
      category: "research",
      generated_at: expect.any(String),
    });
    expect(
      Object.keys(insertedTask.metadata).some(key => /^\d+$/.test(key))
    ).toBe(false);
  });
});
