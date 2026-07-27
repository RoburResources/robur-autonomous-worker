import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  createRateLimiter,
  requireSameOriginMutation,
  securityHeaders,
} from "./httpSecurity";

function responseMock() {
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return {
    headers,
    response: response as unknown as Response,
  };
}

describe("HTTP security middleware", () => {
  it("sets browser security headers and HSTS for HTTPS requests", () => {
    const { headers, response } = responseMock();
    const next = vi.fn() as NextFunction;
    const request = {
      secure: false,
      protocol: "http",
      headers: { "x-forwarded-proto": "https" },
    } as unknown as Request;

    securityHeaders(request, response, next);

    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    expect(headers.get("strict-transport-security")).toContain(
      "max-age=31536000"
    );
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks a client after the configured request budget", () => {
    const limiter = createRateLimiter({
      max: 2,
      windowMs: 60_000,
      namespace: "test",
    });
    const request = {
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      headers: {},
    } as unknown as Request;
    const next = vi.fn();

    limiter(request, responseMock().response, next);
    limiter(request, responseMock().response, next);
    const third = responseMock();
    limiter(request, third.response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(third.response.status).toHaveBeenCalledWith(429);
    expect(third.response.json).toHaveBeenCalledWith({
      error: "Too many requests",
    });
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("does not let a caller evade limits by rotating forwarded IP headers", () => {
    const limiter = createRateLimiter({
      max: 2,
      windowMs: 60_000,
      namespace: "spoof-resistant",
    });
    const next = vi.fn();

    for (const forwardedFor of [
      "198.51.100.10",
      "198.51.100.11",
      "198.51.100.12",
    ]) {
      const request = {
        ip: forwardedFor,
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          "x-forwarded-for": forwardedFor,
          "x-real-ip": forwardedFor,
        },
      } as unknown as Request;
      limiter(request, responseMock().response, next);
    }

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid limiter configuration", () => {
    expect(() =>
      createRateLimiter({ max: 0, windowMs: 1000, namespace: "bad" })
    ).toThrow("Invalid rate-limit configuration");
  });

  it("blocks cross-site mutations and allows same-origin mutations", () => {
    const blocked = responseMock();
    const blockedNext = vi.fn();
    requireSameOriginMutation(
      {
        method: "POST",
        protocol: "https",
        headers: {
          host: "private.example.test",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        get(name: string) {
          return this.headers[name.toLowerCase() as keyof typeof this.headers];
        },
      } as unknown as Request,
      blocked.response,
      blockedNext
    );

    expect(blocked.response.status).toHaveBeenCalledWith(403);
    expect(blockedNext).not.toHaveBeenCalled();

    const allowed = responseMock();
    const allowedNext = vi.fn();
    requireSameOriginMutation(
      {
        method: "POST",
        protocol: "https",
        headers: {
          host: "private.example.test",
          origin: "https://private.example.test",
          "sec-fetch-site": "same-origin",
        },
        get(name: string) {
          return this.headers[name.toLowerCase() as keyof typeof this.headers];
        },
      } as unknown as Request,
      allowed.response,
      allowedNext
    );

    expect(allowedNext).toHaveBeenCalledOnce();
  });
});
