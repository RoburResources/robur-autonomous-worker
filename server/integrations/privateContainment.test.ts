import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSMS } from "./twilio";
import { makeOutboundCall } from "./retell";
import { isSendGridConfigured, sendEmail } from "./sendgrid";

describe("private-candidate provider containment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function enableInternalOnlyCandidate() {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_AUTONOMY", "true");
  }

  it("blocks SMS before any network request", async () => {
    enableInternalOnlyCandidate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendSMS("+61400000000", "containment probe")).resolves.toEqual({
      sid: "blocked",
      status: "blocked_private_candidate",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks outbound calls before any network request", async () => {
    enableInternalOnlyCandidate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeOutboundCall({
        agentId: "agent_test",
        toNumber: "+61400000000",
        fromNumber: "+61411111111",
      })
    ).rejects.toThrow("blocked by private-candidate containment");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks email before any network request", async () => {
    enableInternalOnlyCandidate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail({
      to: "test@example.com",
      subject: "Containment probe",
      bodyText: "This message must never leave the private candidate.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked by private-candidate containment");
    expect(isSendGridConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
