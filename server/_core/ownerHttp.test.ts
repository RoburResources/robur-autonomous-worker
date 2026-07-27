import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const sdkMocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
}));

vi.mock("./env", () => ({
  ENV: { ownerOpenId: "owner-test" },
}));
vi.mock("./sdk", () => ({
  sdk: sdkMocks,
}));

import { requireOwnerHttpRequest } from "./ownerHttp";

function responseMock(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

describe("owner-only HTTP middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows only the configured admin owner", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({
      openId: "owner-test",
      role: "admin",
    });
    const next = vi.fn() as NextFunction;

    await requireOwnerHttpRequest({} as Request, responseMock(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns a generic forbidden response for another user", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({
      openId: "other-user",
      role: "admin",
    });
    const res = responseMock();

    await requireOwnerHttpRequest({} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Forbidden" });
  });

  it("fails closed when authentication throws", async () => {
    sdkMocks.authenticateRequest.mockRejectedValue(new Error("bad session"));
    const res = responseMock();

    await requireOwnerHttpRequest({} as Request, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
