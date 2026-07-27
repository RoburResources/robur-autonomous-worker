import { describe, expect, it } from "vitest";
import {
  isPrivateCandidateInternalAction,
  isPrivateCandidateInternalOnly,
  privateCandidateInternalAutonomyEnabled,
} from "./privateCandidatePolicy";

describe("private candidate policy", () => {
  it("requires both internal-only and autonomous flags", () => {
    expect(
      privateCandidateInternalAutonomyEnabled({
        PRIVATE_CANDIDATE_INTERNAL_AUTONOMY: "true",
        PRIVATE_CANDIDATE_INTERNAL_ONLY: "true",
      })
    ).toBe(true);
    expect(
      privateCandidateInternalAutonomyEnabled({
        PRIVATE_CANDIDATE_INTERNAL_AUTONOMY: "true",
      })
    ).toBe(false);
  });

  it("allows only internal task action types", () => {
    expect(isPrivateCandidateInternalAction("web_research")).toBe(true);
    expect(isPrivateCandidateInternalAction("data_entry")).toBe(true);
    expect(isPrivateCandidateInternalAction("outbound_call")).toBe(false);
    expect(isPrivateCandidateInternalAction("send_sms")).toBe(false);
    expect(isPrivateCandidateInternalAction("send_email")).toBe(false);
  });

  it("fails closed when internal-only mode is absent", () => {
    expect(isPrivateCandidateInternalOnly({})).toBe(false);
  });
});
