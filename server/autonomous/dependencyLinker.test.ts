import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
}));

vi.mock("../_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
}));

vi.mock("../db", () => ({
  getDb: vi.fn(),
}));

import { linkBatchDependencies } from "./dependencyLinker";

describe("dependency linker", () => {
  it("ignores a model resolution that omits dependsOn", async () => {
    mocks.invokeLLM.mockResolvedValue(JSON.stringify([
      { taskId: 1, confidence: 0.9, reasoning: "malformed" },
    ]));

    await expect(
      linkBatchDependencies([{ id: 1, description: "internal task", dependencies: [] }])
    ).resolves.toEqual([]);
  });
});
