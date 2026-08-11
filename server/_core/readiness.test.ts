import { describe, expect, it, vi } from "vitest";
import {
  getServiceReadiness,
  startBackgroundWorkersWhenReady,
} from "./readiness";

describe("service readiness", () => {
  it.each([
    { ready: false as const, databaseSchema: "migration_required" as const },
    { ready: false as const, databaseSchema: "database_unavailable" as const },
  ])(
    "does not start background workers while service readiness is $databaseSchema",
    async readiness => {
      const starters = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
      const started = await startBackgroundWorkersWhenReady(
        starters,
        async () => readiness
      );

      expect(started).toBe(false);
      for (const start of starters) {
        expect(start).not.toHaveBeenCalled();
      }
    }
  );

  it("starts every background worker after service readiness passes", async () => {
    const starters = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const started = await startBackgroundWorkersWhenReady(starters, async () => ({
      ready: true,
      databaseSchema: "ready",
    }));

    expect(started).toBe(true);
    for (const start of starters) {
      expect(start).toHaveBeenCalledOnce();
    }
  });

  it("passes only after the durable provider inbox table is queryable", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ from });

    await expect(getServiceReadiness({ select } as any)).resolves.toEqual({
      ready: true,
      databaseSchema: "ready",
    });
  });

  it("fails closed when the required migration is absent", async () => {
    const missingTable = Object.assign(
      new Error("provider_webhook_inbox does not exist"),
      { code: "ER_NO_SUCH_TABLE" }
    );
    const limit = vi.fn().mockRejectedValue(missingTable);
    const from = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ from });

    await expect(getServiceReadiness({ select } as any)).resolves.toEqual({
      ready: false,
      databaseSchema: "migration_required",
    });
  });

  it("fails closed when the database is unavailable", async () => {
    await expect(getServiceReadiness(null)).resolves.toEqual({
      ready: false,
      databaseSchema: "database_unavailable",
    });
  });

  it("classifies a query connection failure as database unavailable", async () => {
    const limit = vi.fn().mockRejectedValue(
      Object.assign(new Error("connection lost"), {
        code: "ECONNREFUSED",
      })
    );
    const from = vi.fn().mockReturnValue({ limit });
    const select = vi.fn().mockReturnValue({ from });

    await expect(getServiceReadiness({ select } as any)).resolves.toEqual({
      ready: false,
      databaseSchema: "database_unavailable",
    });
  });
});
