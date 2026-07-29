import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
}));

vi.mock("../_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
}));

import {
  reconcileVerificationResult,
  verifyTaskOutcome,
} from "./verifier";

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
    const verificationRequest = mocks.invokeLLM.mock.calls[0][0];
    const systemPrompt = verificationRequest.messages[0].content;
    expect(systemPrompt).toContain(
      "judge the scope actually requested rather than imposing an impossible exhaustive"
    );
    expect(systemPrompt).toContain(
      "Do not penalize honest caveats or require private submissions"
    );
    expect(systemPrompt).toContain(
      "not merely because additional evidence could improve confidence"
    );
  });

  it("fails closed on a contradictory partial retry verdict", () => {
    expect(
      reconcileVerificationResult({
        verified: true,
        score: 0.9,
        verdict: "partial",
        reasoning: "More work is required",
        unintendedSideEffects: [],
        recommendedAction: "retry",
      })
    ).toMatchObject({
      verified: false,
      score: 0.9,
      verdict: "partial",
      recommendedAction: "retry",
    });
  });

  it.each([
    {
      score: 0.79,
      verdict: "pass" as const,
      recommendedAction: "accept" as const,
      unintendedSideEffects: [],
    },
    {
      score: 1,
      verdict: "pass" as const,
      recommendedAction: "retry" as const,
      unintendedSideEffects: [],
    },
    {
      score: 1,
      verdict: "pass" as const,
      recommendedAction: "accept" as const,
      unintendedSideEffects: ["Unexpected mutation"],
    },
  ])("rejects an inconsistent accepted result", fields => {
    expect(
      reconcileVerificationResult({
        verified: true,
        reasoning: "inconsistent",
        ...fields,
      })
    ).toMatchObject({ verified: false });
  });
});
