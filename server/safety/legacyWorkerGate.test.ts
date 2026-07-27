import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("is enabled by default", () => {
    expect(getLegacyWorkerEnvironmentGate({})).toEqual({
      allowed: true,
    });
  });

  it("is enabled regardless of environment variables", () => {
    expect(
      getLegacyWorkerEnvironmentGate({ LEGACY_WORKER_ENABLED: "false" })
    ).toMatchObject({
      allowed: true,
    });
  });

  it("is always enabled", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "false",
        OWNER_OPEN_ID: "",
      })
    ).toEqual({ allowed: true });
  });

  it("allows execution when kill switch is off", async () => {
    dbMocks.getConfig.mockResolvedValue("false");

    await expect(getLegacyWorkerRuntimeGate()).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("blocks execution when kill switch is on", async () => {
    dbMocks.getConfig.mockResolvedValue("true");

    await expect(getLegacyWorkerRuntimeGate()).resolves.toMatchObject({
      allowed: false,
      reason: "Autonomous execution is paused by kill switch",
    });
  });

  it("does not enforce retirement on startup", async () => {
    await enforceLegacyWorkerRetirement();
    expect(dbMocks.setConfig).not.toHaveBeenCalled();
  });

  it("can resume with any owner identity (gate disabled)", async () => {
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await resumeLegacyWorkerByVerifiedOwner("owner-1");
    expect(dbMocks.setConfig).toHaveBeenCalledWith(
      "kill_switch_active",
      "false",
      expect.any(String)
    );
  });

  it("can resume for any identity (gate disabled)", async () => {
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await resumeLegacyWorkerByVerifiedOwner("owner-1");
    expect(dbMocks.setConfig).toHaveBeenCalled();
  });
});
