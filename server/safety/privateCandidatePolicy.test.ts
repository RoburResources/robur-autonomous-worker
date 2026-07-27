import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  blockPrivateCandidateProviderIngress,
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

  it("blocks the entire provider webhook tree in private-only mode", () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");
    const next = vi.fn() as NextFunction;
    const response = {
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);

    blockPrivateCandidateProviderIngress(
      {} as Request,
      response as unknown as Response,
      next
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: "Provider webhooks disabled in private candidate",
    });
    expect(next).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("leaves the provider webhook tree available outside private-only mode", () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    const next = vi.fn() as NextFunction;

    blockPrivateCandidateProviderIngress(
      {} as Request,
      {} as Response,
      next
    );

    expect(next).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
