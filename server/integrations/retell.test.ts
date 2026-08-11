import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRetellCall,
  makeBriefingCall,
  makeOutboundCall,
} from "./retell";

const params = {
  agentId: "agent_test12345678",
  agentVersion: 7,
  fromNumber: "+61411111111",
  toNumber: "+61400000000",
  approvedScript: "Read only this exact approved script.",
  metadata: {
    external_dispatch_id: "22222222-2222-4222-8222-222222222222",
  },
};

const getCallId = "call_test12345678";

function validGetCallResponse(overrides: Record<string, unknown> = {}) {
  return {
    call_id: getCallId,
    agent_id: params.agentId,
    agent_version: params.agentVersion,
    direction: "outbound",
    from_number: params.fromNumber,
    to_number: params.toNumber,
    call_status: "ended",
    disconnection_reason: "agent_hangup",
    metadata: {
      external_dispatch_id: params.metadata.external_dispatch_id,
    },
    call_analysis: {
      call_successful: true,
      call_summary: "The approved call completed successfully.",
      user_sentiment: "Positive",
    },
    ...overrides,
  };
}

describe("Retell exact approved call contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the official pinned-agent fields and exact approved dynamic variable", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          call_id: "call_test",
          call_status: "registered",
          direction: "outbound",
          agent_id: params.agentId,
          agent_version: params.agentVersion,
          from_number: params.fromNumber,
          to_number: params.toNumber,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeOutboundCall(params)).resolves.toEqual({
      callId: "call_test",
      status: "registered",
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      from_number: params.fromNumber,
      to_number: params.toNumber,
      override_agent_id: params.agentId,
      override_agent_version: params.agentVersion,
      retell_llm_dynamic_variables: {
        approved_script: params.approvedScript,
      },
      metadata: params.metadata,
    });
    expect(body).not.toHaveProperty("agent_id");
  });

  it("treats an accepted identity mismatch as an unknown outcome", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            call_id: "call_test",
            call_status: "registered",
            direction: "outbound",
            agent_id: "agent_different1234",
            agent_version: params.agentVersion,
            from_number: params.fromNumber,
            to_number: params.toNumber,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(makeOutboundCall(params)).rejects.toThrow(
      "unexpected agent, version, sender, recipient, or direction"
    );
  });

  it("does not send when any pinned call input is malformed", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeOutboundCall({ ...params, agentVersion: Number.NaN })
    ).rejects.toThrow("Invalid pinned Retell agent version");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the executive-specific agent identity for briefing calls", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubEnv("RETELL_AGENT_ID", "agent_rachel12345678");
    vi.stubEnv("RETELL_AGENT_VERSION", "99");
    vi.stubEnv("RETELL_EXECUTIVE_ASSISTANT_AGENT_ID", params.agentId);
    vi.stubEnv(
      "RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION",
      String(params.agentVersion)
    );
    vi.stubEnv("TWILIO_PHONE_NUMBER", params.fromNumber);
    vi.stubEnv("USER_PHONE", params.toNumber);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          call_id: "call_briefing",
          call_status: "registered",
          direction: "outbound",
          agent_id: params.agentId,
          agent_version: params.agentVersion,
          from_number: params.fromNumber,
          to_number: params.toNumber,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeBriefingCall("morning", "Executive briefing content")
    ).resolves.toMatchObject({
      callId: "call_briefing",
      agentId: params.agentId,
      agentVersion: params.agentVersion,
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.override_agent_id).toBe(params.agentId);
    expect(body.override_agent_version).toBe(params.agentVersion);
    expect(body.override_agent_id).not.toBe("agent_rachel12345678");
  });

  it("uses the certified owner phone for briefing calls", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubEnv("RETELL_EXECUTIVE_ASSISTANT_AGENT_ID", params.agentId);
    vi.stubEnv(
      "RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION",
      String(params.agentVersion)
    );
    vi.stubEnv("TWILIO_PHONE_NUMBER", params.fromNumber);
    vi.stubEnv("OWNER_PHONE_E164", params.toNumber);
    vi.stubEnv("USER_PHONE", "");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          call_id: "call_owner_briefing",
          call_status: "registered",
          direction: "outbound",
          agent_id: params.agentId,
          agent_version: params.agentVersion,
          from_number: params.fromNumber,
          to_number: params.toNumber,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeBriefingCall("evening", "Executive briefing content")
    ).resolves.toMatchObject({
      callId: "call_owner_briefing",
      toNumber: params.toNumber,
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.to_number).toBe(params.toNumber);
  });

  it("does not fall back to a generic Retell agent for briefing calls", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubEnv("RETELL_AGENT_ID", "agent_rachel12345678");
    vi.stubEnv("RETELL_AGENT_VERSION", "99");
    vi.stubEnv("RETELL_EXECUTIVE_ASSISTANT_AGENT_ID", "");
    vi.stubEnv("RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION", "");
    vi.stubEnv("TWILIO_PHONE_NUMBER", params.fromNumber);
    vi.stubEnv("USER_PHONE", params.toNumber);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeBriefingCall("morning", "Executive briefing content")
    ).rejects.toThrow("RETELL_EXECUTIVE_ASSISTANT_AGENT_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Retell Get Call contract", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the official bounded GET route and returns validated camelCase fields", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(validGetCallResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRetellCall(getCallId)).resolves.toEqual({
      callId: getCallId,
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      direction: "outbound",
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      callStatus: "ended",
      disconnectionReason: "agent_hangup",
      externalDispatchId: params.metadata.external_dispatch_id,
      callSuccessful: true,
      callSummary: "The approved call completed successfully.",
      userSentiment: "Positive",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.retellai.com/v2/get-call/${getCallId}`
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer test-only-key",
      },
    });
    expect(init).not.toHaveProperty("body");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it("normalizes legitimately absent terminal analysis fields without inventing an outcome", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            validGetCallResponse({
              call_status: "ongoing",
              disconnection_reason: null,
              metadata: {},
              call_analysis: null,
            })
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await getRetellCall(getCallId);
    expect(result).toEqual({
      callId: getCallId,
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      direction: "outbound",
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      callStatus: "ongoing",
      disconnectionReason: "",
      callSummary: "",
      userSentiment: "",
    });
    expect(result).not.toHaveProperty("externalDispatchId");
    expect(result).not.toHaveProperty("callSuccessful");
  });

  it.each([
    ["an unsafe call ID", "../call"],
    ["an empty call ID", ""],
    ["an overlong call ID", `call_${"a".repeat(160)}`],
  ])("rejects %s before network access", async (_label, callId) => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRetellCall(callId)).rejects.toThrow(
      "Invalid Retell call ID"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the configured API key before network access", async () => {
    vi.stubEnv("RETELL_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRetellCall(getCallId)).rejects.toThrow(
      "RETELL_API_KEY not configured"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched and malformed provider identities", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const invalidResponses = [
      validGetCallResponse({ call_id: "call_different123" }),
      validGetCallResponse({ agent_id: "unexpected-agent" }),
      validGetCallResponse({ agent_version: -1 }),
      validGetCallResponse({ direction: "sideways" }),
      validGetCallResponse({ from_number: "not-e164" }),
      validGetCallResponse({ to_number: "not-e164" }),
      validGetCallResponse({ call_status: "mystery" }),
      validGetCallResponse({ disconnection_reason: "unknown_reason" }),
      validGetCallResponse({
        metadata: { external_dispatch_id: "not-a-uuid" },
      }),
      validGetCallResponse({
        call_analysis: {
          call_successful: "yes",
          call_summary: "summary",
          user_sentiment: "Positive",
        },
      }),
      validGetCallResponse({
        call_analysis: {
          call_successful: true,
          call_summary: "x".repeat(20_001),
          user_sentiment: "Positive",
        },
      }),
      validGetCallResponse({
        call_analysis: {
          call_successful: true,
          call_summary: "summary",
          user_sentiment: "x".repeat(65),
        },
      }),
    ];
    const fetchMock = vi.fn();
    for (const response of invalidResponses) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    vi.stubGlobal("fetch", fetchMock);

    for (const _response of invalidResponses) {
      await expect(getRetellCall(getCallId)).rejects.toThrow(
        "Retell Get Call returned an invalid response"
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(invalidResponses.length);
  });

  it("does not expose provider response bodies in HTTP errors", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("provider-secret-response-body", { status: 401 })
      )
    );

    let error: unknown;
    try {
      await getRetellCall(getCallId);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Retell Get Call failed with HTTP 401"
    );
    expect((error as Error).message).not.toContain("provider-secret");
  });

  it("aborts a Get Call request at the bounded timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("provider-secret-timeout-detail");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = expect(getRetellCall(getCallId)).rejects.toThrow(
      "Retell Get Call request timed out"
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("rejects an oversized response without exposing its content", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    const oversized = "provider-secret-" + "x".repeat(256 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(oversized, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    let error: unknown;
    try {
      await getRetellCall(getCallId);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Retell Get Call returned an invalid response"
    );
    expect((error as Error).message).not.toContain("provider-secret");
  });

  it("cancels an oversized chunked response before buffering the remaining stream", async () => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(128 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls >= 20) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(getRetellCall(getCallId)).rejects.toThrow(
      "Retell Get Call returned an invalid response"
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it.each([
    ["wrong content type", { "Content-Type": "text/plain" }],
    [
      "declared oversized body",
      {
        "Content-Type": "application/json",
        "Content-Length": String(256 * 1024 + 1),
      },
    ],
  ])("cancels the body on early rejection for %s", async (_label, headers) => {
    vi.stubEnv("RETELL_API_KEY", "test-only-key");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("provider-body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers }))
    );

    await expect(getRetellCall(getCallId)).rejects.toThrow(
      "Retell Get Call returned an invalid response"
    );
    expect(cancelled).toBe(true);
  });
});
