import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => {
  process.env.OWNER_OPEN_ID = "owner-status-audit-test";
  return {
    updateTaskByOwnerWithAudit: vi.fn(),
  };
});

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    updateTaskByOwnerWithAudit: mocks.updateTaskByOwnerWithAudit,
  };
});

import { appRouter } from "./routers";

function ownerContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "owner-status-audit-test",
      email: "owner@example.test",
      name: "Owner",
      loginMethod: "test",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("owner task status audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateTaskByOwnerWithAudit.mockResolvedValue({
      outcome: "updated",
      previousStatus: "pending",
      nextStatus: "failed",
      statusChanged: true,
    });
  });

  it("delegates a manual failed transition to the atomic audited update", async () => {
    const caller = appRouter.createCaller(ownerContext());

    await expect(
      caller.tasks.update({ id: 9, status: "failed" })
    ).resolves.toEqual({ success: true });

    expect(mocks.updateTaskByOwnerWithAudit).toHaveBeenCalledWith(
      9,
      { status: "failed" }
    );
  });

  it("delegates a priority-only edit to the same atomic update", async () => {
    mocks.updateTaskByOwnerWithAudit.mockResolvedValue({
      outcome: "updated",
      previousStatus: "pending",
      nextStatus: "pending",
      statusChanged: false,
    });
    const caller = appRouter.createCaller(ownerContext());

    await caller.tasks.update({ id: 9, priorityScore: 70 });

    expect(mocks.updateTaskByOwnerWithAudit).toHaveBeenCalledWith(
      9,
      { priorityScore: 70 }
    );
  });

  it("rejects updates to a missing task", async () => {
    mocks.updateTaskByOwnerWithAudit.mockResolvedValue({
      outcome: "not_found",
    });
    const caller = appRouter.createCaller(ownerContext());

    await expect(
      caller.tasks.update({ id: 404, status: "completed" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateTaskByOwnerWithAudit).toHaveBeenCalledWith(
      404,
      { status: "completed" }
    );
  });

  it("rejects an empty update before touching the database", async () => {
    const caller = appRouter.createCaller(ownerContext());

    await expect(
      caller.tasks.update({ id: 9 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateTaskByOwnerWithAudit).not.toHaveBeenCalled();
  });
});
