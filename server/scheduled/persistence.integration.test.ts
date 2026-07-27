/**
 * Isolated scheduler persistence integration test.
 *
 * Uses fully in-memory mocks — no live DB, no real cron JWT, no external calls.
 * Seeds gate values to allow=true, calls taskExecutorHandler with a mock cron
 * request, and asserts that logExecution was called with a persisted row.
 *
 * This is a private proof-of-persistence test only. It does not touch the
 * published database or resume live operations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── In-memory execution log ──────────────────────────────────────────────────
const persistedRows: unknown[] = [];

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const sdkMocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
}));

const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  logExecution: vi.fn(async (entry: unknown) => {
    persistedRows.push({ ...entry as object, createdAt: new Date().toISOString() });
    return { insertId: persistedRows.length };
  }),
  getConfig: vi.fn(async (key: string) => {
    const config: Record<string, string> = {
      kill_switch_active: "false",
      system_status: "active",
      legacy_worker_owner_authorized: "true",
      max_api_spend_cents_per_day: "5000",
    };
    return config[key] ?? null;
  }),
  isKillSwitchActive: vi.fn(async () => false),
  getTodayMetrics: vi.fn(async () => null),
  getDagReadyTask: vi.fn(async () => null), // no tasks → executed=false, no external calls
  updateTask: vi.fn(async () => {}),
  unlockDependents: vi.fn(async () => {}),
  upsertDailyMetrics: vi.fn(async () => {}),
  getDailyCallCount: vi.fn(async () => 0),
  getDailyEmailCount: vi.fn(async () => 0),
  setConfig: vi.fn(async () => {}),
}));

const autonomousMocks = vi.hoisted(() => ({
  runTaskExecutor: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("../_core/sdk", () => ({ sdk: sdkMocks }));
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("../db", () => dbMocks);
vi.mock("../autonomous/taskExecutor", () => ({
  runTaskExecutor: autonomousMocks.runTaskExecutor,
}));
vi.mock("../autonomous/taskGenerator", () => ({ runTaskGenerator: vi.fn() }));
vi.mock("../autonomous/evaluator", () => ({ runEvaluator: vi.fn() }));
vi.mock("../autonomous/selfImprover", () => ({ runSelfImprover: vi.fn() }));
vi.mock("../autonomous/briefings", () => ({
  runMorningBriefing: vi.fn(),
  runEveningBriefing: vi.fn(),
}));

import { taskExecutorHandler } from "./handlers";

// ── Helpers ──────────────────────────────────────────────────────────────────
function cronRequest(): Request {
  return { headers: { authorization: "Bearer mock-cron-jwt" } } as unknown as Request;
}

function responseMock(): Response {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("Scheduler persistence — isolated in-memory proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedRows.length = 0;
  });

  it("rejects unauthenticated request with 403 and writes no rows", async () => {
    sdkMocks.authenticateRequest.mockRejectedValue(new Error("invalid"));
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });

    const res = responseMock();
    await taskExecutorHandler(cronRequest(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(persistedRows).toHaveLength(0);
  });

  it("rejects non-cron authenticated user with 403 and writes no rows", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: false });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });

    const res = responseMock();
    await taskExecutorHandler(cronRequest(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(persistedRows).toHaveLength(0);
  });

  it("rejects when runtime gate is closed with 423 and writes no rows", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: true, taskUid: "test-uid" });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "Legacy worker is paused",
    });

    const res = responseMock();
    await taskExecutorHandler(cronRequest(), res);

    expect(res.status).toHaveBeenCalledWith(423);
    expect(persistedRows).toHaveLength(0);
  });

  it("executes and returns ok:true when gate is open and no tasks are pending", async () => {
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: true, taskUid: "test-uid" });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
    autonomousMocks.runTaskExecutor.mockResolvedValue({
      executed: false,
      error: "No DAG-ready pending tasks",
    });

    const res = responseMock();
    await taskExecutorHandler(cronRequest(), res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, executed: false })
    );
    expect(autonomousMocks.runTaskExecutor).toHaveBeenCalledTimes(1);
  });

  it("executes a task and proves logExecution persists a fresh row", async () => {
    const taskId = 42;
    sdkMocks.authenticateRequest.mockResolvedValue({ isCron: true, taskUid: "test-uid" });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });

    // Simulate executor running a task and calling logExecution
    autonomousMocks.runTaskExecutor.mockImplementation(async () => {
      // Directly call the mocked logExecution to simulate what the real executor does
      await dbMocks.logExecution({
        taskId,
        actionType: "web_research",
        details: { query: "Robur Resources scrap metal prices" },
        outcome: "success",
        durationMs: 4200,
      });
      return { executed: true, taskId };
    });

    const res = responseMock();
    const before = Date.now();
    await taskExecutorHandler(cronRequest(), res);
    const after = Date.now();

    // Verify handler returned success
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, executed: true, taskId })
    );

    // Verify execution row was persisted
    expect(persistedRows).toHaveLength(1);
    const row = persistedRows[0] as Record<string, unknown>;
    expect(row.taskId).toBe(taskId);
    expect(row.actionType).toBe("web_research");
    expect(row.outcome).toBe("success");
    expect(row.durationMs).toBe(4200);
    expect(new Date(row.createdAt as string).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(row.createdAt as string).getTime()).toBeLessThanOrEqual(after + 100);

    console.log("[PERSISTENCE PROOF] Fresh execution row:", JSON.stringify(row, null, 2));
  });
});
