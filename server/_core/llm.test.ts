import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({
  ENV: {
    forgeApiUrl: "https://api.openai.com",
    forgeApiKey: "test-key",
  },
}));

import { invokeLLM } from "./llm";

const successResponse = () =>
  new Response(
    JSON.stringify({
      id: "test-response",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

describe("invokeLLM token limits", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses max_completion_tokens for the configured GPT-5.6 model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successResponse());

    await invokeLLM({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "Reply OK" }],
      maxTokens: 64,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      max_completion_tokens: 64,
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps max_tokens for the configured GPT-4o model", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successResponse());

    await invokeLLM({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Reply OK" }],
      maxTokens: 64,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: "gpt-4o-mini", max_tokens: 64 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
