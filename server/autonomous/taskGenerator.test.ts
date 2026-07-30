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

import {
  runTaskGenerator,
  taskDescriptionsOverlap,
  withPrivateResearchEvidenceContract,
} from "./taskGenerator";
import { PRIVATE_RESEARCH_EVIDENCE_CONTRACT } from "./researchCompletionContract";

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
    expect(insertedTask.description).toContain(
      "Use only current publicly accessible sources."
    );
    expect(insertedTask.description).toMatch(
      /^Public-evidence research objective\.\nCompletion contract: /
    );
    expect(insertedTask.description).toContain(
      "a complete evidence-availability conclusion"
    );
    expect(typeof insertedTask.metadata).toBe("object");
    expect(insertedTask.metadata).toEqual({
      roiScore: 8,
      phase: 1,
      requiresExternalContact: false,
      dependencies: [],
      dag_dependencies: [],
      category: "research",
      generated_at: expect.any(String),
      generation_novelty_key:
        "australian guidance market official recovery research western",
      research_completion_contract_version: 2,
      public_evidence_only: true,
      evidence_gap_is_valid_completion: true,
    });
    expect(
      Object.keys(insertedTask.metadata).some(key => /^\d+$/.test(key))
    ).toBe(false);

    const systemPrompt = mocks.invokeLLM.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain(
      "answerable now from current publicly accessible sources"
    );
    expect(systemPrompt).toContain(
      "Do not make private, proprietary, undisclosed, contact-required, or future data a required deliverable"
    );
  });

  it("does not alter non-private task descriptions or metadata", async () => {
    mocks.isPrivateCandidateInternalOnly.mockReturnValue(false);

    await expect(runTaskGenerator()).resolves.toEqual({ tasksCreated: 1 });

    const insertedTask = mocks.createTask.mock.calls[0][0];
    expect(insertedTask.description).toBe(
      "Research official Western Australian recovery-market guidance."
    );
    expect(insertedTask.metadata).not.toHaveProperty(
      "research_completion_contract_version"
    );
    expect(insertedTask.metadata).not.toHaveProperty("public_evidence_only");
    expect(insertedTask.metadata).not.toHaveProperty(
      "evidence_gap_is_valid_completion"
    );
  });

  it("skips generation before calling the model when the private queue is full", async () => {
    mocks.getRecentTasks.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        description: `Pending private task ${index + 1}`,
        status: "pending",
      }))
    );

    await expect(runTaskGenerator()).resolves.toEqual({
      tasksCreated: 0,
      error: "Queue already has 5 pending tasks (limit 5) — skipping generation",
    });
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("filters a generated description that duplicates recent work", async () => {
    mocks.getRecentTasks.mockResolvedValue([
      {
        id: 90,
        description:
          "Research official Western Australian recovery-market guidance.",
        status: "completed",
      },
    ]);

    await expect(runTaskGenerator()).resolves.toEqual({ tasksCreated: 0 });
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.logExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ duplicatesFiltered: 1 }),
      })
    );
  });
});

describe("task generation duplicate detection", () => {
  it("adds the private research evidence contract exactly once", () => {
    const description = "Research Perth hardstand demand.";
    const once = withPrivateResearchEvidenceContract(description);

    expect(once).toContain(description);
    expect(withPrivateResearchEvidenceContract(once)).toBe(once);
    expect(taskDescriptionsOverlap(description, once)).toBe(true);

    const legacyV1 = `${description}

Completion contract: Use only current publicly accessible sources. A well-supported finding that requested information is not publicly disclosed is a complete evidence-availability conclusion; do not invent values or require private records, external contact, or future access.`;
    expect(taskDescriptionsOverlap(description, legacyV1)).toBe(true);
  });

  it("does not let quoted or nested contract boilerplate suppress distinct tasks", () => {
    const candidate =
      `Assess Perth commercial hardstand annual lease rates and utility costs. ` +
      `Quoted policy: ${PRIVATE_RESEARCH_EVIDENCE_CONTRACT}`;
    const existing = withPrivateResearchEvidenceContract(
      `Review Western Australian planning permit requirements for industrial ` +
      `recycling yards. Nested policy: ${PRIVATE_RESEARCH_EVIDENCE_CONTRACT} ` +
      `This quoted text does not change the task.`
    );

    expect(taskDescriptionsOverlap(candidate, existing)).toBe(false);
  });

  it.each([
    [
      "Contact suppliers for copper pricing.",
      "Research suppliers for copper pricing.",
    ],
    [
      "Assess public pricing evidence for Perth hardstand leasing.",
      "Assess private pricing evidence for Perth hardstand leasing.",
    ],
  ])("preserves action and scope words outside contract boilerplate", (
    candidate,
    existing
  ) => {
    expect(taskDescriptionsOverlap(candidate, existing)).toBe(false);
  });

  it("still detects an identical short public-records task", () => {
    expect(
      taskDescriptionsOverlap(
        "Research public records access.",
        "Research public records access."
      )
    ).toBe(true);
  });

  it("detects reordered near-identical task descriptions", () => {
    expect(
      taskDescriptionsOverlap(
        "Compile official Perth planning requirements for hardstand development and local zoning restrictions.",
        "Research local zoning restrictions and official planning requirements for hardstand development in Perth."
      )
    ).toBe(true);
  });

  it("does not collapse distinct research scopes", () => {
    expect(
      taskDescriptionsOverlap(
        "Research environmental assessment requirements for hardstand development.",
        "Identify public grants available for industrial land infrastructure."
      )
    ).toBe(false);
  });
});
