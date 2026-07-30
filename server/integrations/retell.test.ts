import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOutboundCall } from "./retell";

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
});
