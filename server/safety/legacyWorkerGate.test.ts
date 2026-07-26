import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const dbMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}));

vi.mock("../db", () => dbMocks);

import {
  LEGACY_WORKER_RISK_ACK,
  enforceLegacyWorkerRetirement,
  getLegacyWorkerEnvironmentGate,
  getLegacyWorkerRuntimeGate,
  resumeLegacyWorkerByVerifiedOwner,
} from "./legacyWorkerGate";

describe("legacy worker safety gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("is retired by default", () => {
    expect(getLegacyWorkerEnvironmentGate({})).toEqual({
      allowed: false,
      reason: "Legacy worker is retired by deployment policy",
    });
  });

  it("does not accept a boolean opt-in without the exact risk acknowledgement", () => {
    expect(
      getLegacyWorkerEnvironmentGate({ LEGACY_WORKER_ENABLED: "true" })
    ).toMatchObject({
      allowed: false,
    });
  });

  it("requires both explicit deployment controls", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "true",
        LEGACY_WORKER_RISK_ACK,
        OWNER_OPEN_ID: "owner-1",
      })
    ).toEqual({ allowed: true });
  });

  it("blocks an old active database state without verified owner authorization", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    dbMocks.getConfig.mockImplementation(
      async (key: string) =>
        ({
          legacy_worker_owner_authorized: null,
          kill_switch_active: "false",
          legacy_worker_owner_identity_digest: createHash("sha256")
            .update("owner-1")
            .digest("hex"),
          system_status: "active",
        })[key as "legacy_worker_owner_authorized"] ?? null
    );

    await expect(getLegacyWorkerRuntimeGate()).resolves.toMatchObject({
      allowed: false,
      reason: "Verified owner authorization is required",
    });
  });

  it("only enables execution for the exact owner/kill-switch/status state", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    const state: Record<string, string> = {
      legacy_worker_owner_authorized: "true",
      legacy_worker_owner_identity_digest: createHash("sha256")
        .update("owner-1")
        .digest("hex"),
      kill_switch_active: "false",
      system_status: "active",
    };
    dbMocks.getConfig.mockImplementation(
      async (key: string) => state[key] ?? null
    );

    await expect(getLegacyWorkerRuntimeGate()).resolves.toEqual({
      allowed: true,
    });
  });

  it("overrides stale active state during retired startup", async () => {
    await enforceLegacyWorkerRetirement();

    expect(dbMocks.setConfig).toHaveBeenCalledWith(
      "kill_switch_active",
      "true",
      expect.any(String)
    );
    expect(dbMocks.setConfig).toHaveBeenCalledWith(
      "system_status",
      "retired",
      expect.any(String)
    );
    expect(dbMocks.setConfig).toHaveBeenCalledWith(
      "legacy_worker_owner_authorized",
      "false",
      expect.any(String)
    );
  });

  it("cannot resume without deployment opt-in", async () => {
    await expect(resumeLegacyWorkerByVerifiedOwner("owner-1")).rejects.toThrow(
      "retired"
    );
    expect(dbMocks.setConfig).not.toHaveBeenCalled();
  });

  it("cannot resume for an identity other than the configured owner", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");

    await expect(
      resumeLegacyWorkerByVerifiedOwner("someone-else")
    ).rejects.toThrow("does not match");
    expect(dbMocks.setConfig).not.toHaveBeenCalled();
  });
});
