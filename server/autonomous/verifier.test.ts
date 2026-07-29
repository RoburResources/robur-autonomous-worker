import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
}));

vi.mock("../_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
}));

import { verifyTaskOutcome } from "./verifier";

describe("task verifier", () => {
  it("uses the configured supported model for private verification", async () => {
    mocks.invokeLLM.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            verified: true,
            score: 1,
            verdict: "pass",
            reasoning: "complete",
            unintendedSideEffects: [],
            recommendedAction: "accept",
          }),
        },
      }],
    });

    await expect(verifyTaskOutcome({ id: 1, description: "internal task" })).resolves.toMatchObject({
      verified: true,
      verdict: "pass",
    });
    expect(mocks.invokeLLM).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4o-mini" }));
  });
});
