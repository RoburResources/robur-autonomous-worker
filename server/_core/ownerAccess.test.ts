import express from "express";
import { createServer } from "node:http";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  claimPrivateOwnerAccessToken: vi.fn(),
  upsertUser: vi.fn(),
}));
const sdkMocks = vi.hoisted(() => ({
  createSessionToken: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("./sdk", () => ({ sdk: sdkMocks }));
vi.mock("./env", () => ({
  ENV: {
    appId: "private-app",
    cookieSecret: "test-owner-secret-that-is-long-enough",
    ownerOpenId: "owner-michael",
  },
}));

import { registerOwnerAccessRoutes } from "./ownerAccess";

const activeServers: Array<ReturnType<typeof createServer>> = [];

async function request(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const app = express();
  app.use(express.json());
  registerOwnerAccessRoutes(app);
  const server = createServer(app);
  activeServers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

async function validBootstrapToken(jti = "one-use-id"): Promise<string> {
  return new SignJWT({
    purpose: "private_owner_access",
    openId: "owner-michael",
    appId: "private-app",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(jti)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode("test-owner-secret-that-is-long-enough"));
}

describe("direct private owner access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "true");
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_AUTONOMY", "true");
    dbMocks.claimPrivateOwnerAccessToken.mockResolvedValue(true);
    dbMocks.upsertUser.mockResolvedValue(undefined);
    sdkMocks.createSessionToken.mockResolvedValue("bounded-owner-session");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      activeServers.splice(0).map(
        server =>
          new Promise<void>(resolve => server.close(() => resolve()))
      )
    );
  });

  it("exposes no GET bootstrap or Manus OAuth callback", async () => {
    const access = await request("/api/private-owner/access");
    const callback = await request("/api/oauth/callback?code=x&state=y");

    expect(access.status).toBe(404);
    expect(callback.status).toBe(404);
  });

  it("fails closed outside the isolated private candidate", async () => {
    vi.stubEnv("PRIVATE_CANDIDATE_INTERNAL_ONLY", "false");
    const response = await request("/api/private-owner/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: await validBootstrapToken() }),
    });

    expect(response.status).toBe(404);
    expect(dbMocks.upsertUser).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and invalid exchanges", async () => {
    const crossOrigin = await request("/api/private-owner/access", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid",
      },
      body: JSON.stringify({ token: await validBootstrapToken() }),
    });
    const invalid = await request("/api/private-owner/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-jwt" }),
    });

    expect(crossOrigin.status).toBe(403);
    expect(invalid.status).toBe(403);
    expect(dbMocks.upsertUser).not.toHaveBeenCalled();
  });

  it("creates a bounded cookie and mobile bearer without a redirect", async () => {
    const response = await request("/api/private-owner/access", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ token: await validBootstrapToken() }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(body.sessionToken).toBe("bounded-owner-session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=43200");
    expect(dbMocks.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        openId: "owner-michael",
        role: "admin",
      })
    );
  });

  it("rejects a durably consumed one-time credential", async () => {
    dbMocks.claimPrivateOwnerAccessToken.mockResolvedValue(false);
    const response = await request("/api/private-owner/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: await validBootstrapToken("replayed-id") }),
    });

    expect(response.status).toBe(403);
    expect(sdkMocks.createSessionToken).not.toHaveBeenCalled();
  });
});
