import { beforeEach, describe, expect, it, vi } from "vitest";
const dbMocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfigsAtomically: vi.fn(),
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
    dbMocks.getConfig.mockResolvedValue(null);
  });

  it("is retired by default", () => {
    expect(getLegacyWorkerEnvironmentGate({})).toEqual({
      allowed: false,
      reason: "Legacy worker deployment opt-in is not enabled",
    });
  });

  it("requires the exact risk acknowledgement", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "true",
        LEGACY_WORKER_RISK_ACK: "almost",
        OWNER_OPEN_ID: "owner-1",
      })
    ).toMatchObject({
      allowed: false,
      reason: "Legacy worker risk acknowledgement is missing or invalid",
    });
  });

  it("requires a valid configured owner identity", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "true",
        LEGACY_WORKER_RISK_ACK,
        OWNER_OPEN_ID: "",
      })
    ).toEqual({
      allowed: false,
      reason: "No valid verified owner identity is configured",
    });
  });

  it("opens the deployment gate only with the exact opt-in tuple", () => {
    expect(
      getLegacyWorkerEnvironmentGate({
        LEGACY_WORKER_ENABLED: "true",
        LEGACY_WORKER_RISK_ACK,
        OWNER_PHONE_E164: "+61400000000",
      })
    ).toEqual({ allowed: true });
  });

  it("allows execution only for the exact active owner-authorized tuple", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    const digest = await sha256("owner-1");
    dbMocks.getConfig.mockImplementation(async (key: string) => {
      if (key === "kill_switch_active") return "false";
      if (key === "system_status") return "active";
      if (key === "legacy_worker_owner_authorized") return "true";
      if (key === "legacy_worker_owner_identity_digest") return digest;
      return null;
    });

    await expect(getLegacyWorkerRuntimeGate()).resolves.toMatchObject({
      allowed: true,
    });
  });

  it.each([
    ["kill_switch_active", null, "Autonomous execution is paused by kill switch"],
    [
      "system_status",
      "paused",
      "Autonomous execution requires exact active system status",
    ],
    [
      "legacy_worker_owner_authorized",
      "false",
      "Autonomous execution has not been resumed by a verified owner",
    ],
    [
      "legacy_worker_owner_identity_digest",
      "wrong",
      "Stored owner authorization does not match configured owner",
    ],
  ])("fails closed when %s is invalid or missing", async (key, value, reason) => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    const digest = await sha256("owner-1");
    const values: Record<string, string | null> = {
      kill_switch_active: "false",
      system_status: "active",
      legacy_worker_owner_authorized: "true",
      legacy_worker_owner_identity_digest: digest,
    };
    values[key] = value;
    dbMocks.getConfig.mockImplementation(async (configKey: string) => values[configKey]);

    await expect(getLegacyWorkerRuntimeGate()).resolves.toMatchObject({
      allowed: false,
      reason,
    });
  });

  it("atomically retires stale state on startup when the environment is closed", async () => {
    await expect(enforceLegacyWorkerRetirement()).resolves.toMatchObject({
      allowed: false,
    });
    expect(dbMocks.setConfigsAtomically).toHaveBeenCalledWith([
      expect.objectContaining({ key: "kill_switch_active", value: "true" }),
      expect.objectContaining({ key: "system_status", value: "retired" }),
      expect.objectContaining({
        key: "legacy_worker_owner_authorized",
        value: "false",
      }),
    ]);
  });

  it("does not rewrite persisted state when the environment is open", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await enforceLegacyWorkerRetirement();
    expect(dbMocks.setConfigsAtomically).not.toHaveBeenCalled();
  });

  it("rejects resume while the deployment gate is closed", async () => {
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await expect(resumeLegacyWorkerByVerifiedOwner("owner-1")).rejects.toThrow(
      "Legacy worker deployment opt-in is not enabled"
    );
    expect(dbMocks.setConfigsAtomically).not.toHaveBeenCalled();
  });

  it("rejects resume by an unconfigured identity", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await expect(resumeLegacyWorkerByVerifiedOwner("owner-2")).rejects.toThrow(
      "Verified owner identity does not match configuration"
    );
    expect(dbMocks.setConfigsAtomically).not.toHaveBeenCalled();
  });

  it("atomically resumes only the exact configured owner", async () => {
    vi.stubEnv("LEGACY_WORKER_ENABLED", "true");
    vi.stubEnv("LEGACY_WORKER_RISK_ACK", LEGACY_WORKER_RISK_ACK);
    vi.stubEnv("OWNER_OPEN_ID", "owner-1");
    await resumeLegacyWorkerByVerifiedOwner("owner-1");
    expect(dbMocks.setConfigsAtomically).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: "kill_switch_active",
          value: "false",
        }),
      ])
    );
  });
});

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
}
