import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { ownerProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getLegacyWorkerEnvironmentGate,
  getLegacyWorkerRuntimeGate,
  pauseLegacyWorker,
  resumeLegacyWorkerByVerifiedOwner,
} from "./safety/legacyWorkerGate";
import {
  getAllGoals, getActiveGoals, createGoal, updateGoal,
  getRecentTasks, getTasksByStatus, updateTaskByOwnerWithAudit, createTask,
  getRecentExecutions, getExecutionsForTask,
  getRecentEvaluations,
  getOpportunities, createOpportunity, updateOpportunity,
  getAllConfig, getConfig, setConfig,
  getRecentMetrics, getTodayMetrics,
  getDailyCallCount, getDailyEmailCount,
} from "./db";
import { runTaskExecutor } from "./autonomous/taskExecutor";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Goals ────────────────────────────────────────────────────────────────
  goals: router({
    list: ownerProcedure.query(async () => {
      return getAllGoals();
    }),
    active: ownerProcedure.query(async () => {
      return getActiveGoals();
    }),
    create: ownerProcedure
      .input(z.object({
        goalText: z.string().trim().min(1).max(4_000),
        priority: z.number().min(1).max(10).default(5),
        subGoals: z.array(z.string().trim().min(1).max(1_000)).max(50).optional(),
      }))
      .mutation(async ({ input }) => {
        await createGoal({
          goalText: input.goalText,
          priority: input.priority,
          subGoals: input.subGoals ? JSON.stringify(input.subGoals) : null,
          status: "active",
        });
        return { success: true };
      }),
    update: ownerProcedure
      .input(z.object({
        id: z.number().int().positive(),
        goalText: z.string().trim().min(1).max(4_000).optional(),
        status: z.enum(["active", "paused", "completed", "archived"]).optional(),
        priority: z.number().min(1).max(10).optional(),
        subGoals: z.array(z.string().trim().min(1).max(1_000)).max(50).optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const updateData: any = { ...data };
        if (data.subGoals) updateData.subGoals = JSON.stringify(data.subGoals);
        await updateGoal(id, updateData);
        return { success: true };
      }),
  }),

  // ─── Tasks ────────────────────────────────────────────────────────────────
  tasks: router({
    list: ownerProcedure
      .input(
        z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional()
      )
      .query(async ({ input }) => {
        return getRecentTasks(input?.limit || 100);
      }),
    byStatus: ownerProcedure
      .input(z.object({
        status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "awaiting_approval"]),
        limit: z.number().int().min(1).max(500).default(50),
      }))
      .query(async ({ input }) => {
        return getTasksByStatus(input.status, input.limit);
      }),
    update: ownerProcedure
      .input(z.object({
        id: z.number().int().positive(),
        status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "awaiting_approval"]).optional(),
        priorityScore: z.number().int().min(1).max(100).optional(),
      }).refine(
        input => input.status !== undefined || input.priorityScore !== undefined,
        { message: "A status or priority update is required" }
      ))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const result = await updateTaskByOwnerWithAudit(id, data);
        if (result.outcome === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Task not found",
          });
        }
        return { success: true };
      }),
    create: ownerProcedure
      .input(z.object({
        description: z.string().trim().min(10).max(4_000),
        actionType: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .default("web_research"),
        priorityScore: z.number().int().min(1).max(100).default(50),
        goalId: z.number().int().positive().optional(),
      }))
      .mutation(async ({ input }) => {
        const result = await createTask({
          description: input.description,
          actionType: input.actionType,
          priorityScore: input.priorityScore,
          goalId: input.goalId,
          source: "manual",
          status: "pending",
        });
        const taskId = Number(
          (result as any)?.[0]?.insertId ?? (result as any)?.insertId
        );
        if (!Number.isInteger(taskId) || taskId <= 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Task was not assigned a valid ID",
          });
        }
        return { success: true, taskId };
      }),
    run: ownerProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        return runTaskExecutor(input.id);
      }),
  }),

  // ─── Execution Log ────────────────────────────────────────────────────────
  executions: router({
    list: ownerProcedure
      .input(
        z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional()
      )
      .query(async ({ input }) => {
        return getRecentExecutions(input?.limit || 100);
      }),
    forTask: ownerProcedure
      .input(z.object({ taskId: z.number().int().positive() }))
      .query(async ({ input }) => {
        return getExecutionsForTask(input.taskId);
      }),
  }),

  // ─── Evaluations ─────────────────────────────────────────────────────────
  evaluations: router({
    list: ownerProcedure
      .input(
        z.object({ limit: z.number().int().min(1).max(500).default(50) }).optional()
      )
      .query(async ({ input }) => {
        return getRecentEvaluations(input?.limit || 50);
      }),
  }),

  // ─── Opportunities ────────────────────────────────────────────────────────
  opportunities: router({
    list: ownerProcedure
      .input(
        z.object({ limit: z.number().int().min(1).max(500).default(50) }).optional()
      )
      .query(async ({ input }) => {
        return getOpportunities(input?.limit || 50);
      }),
    create: ownerProcedure
      .input(z.object({
        source: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(4_000),
        priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
        estimatedValue: z.string().trim().max(100).optional(),
      }))
      .mutation(async ({ input }) => {
        await createOpportunity({
          source: input.source,
          description: input.description,
          priority: input.priority,
          estimatedValue: input.estimatedValue,
        });
        return { success: true };
      }),
    update: ownerProcedure
      .input(z.object({
        id: z.number().int().positive(),
        status: z.enum(["new", "investigating", "actioned", "dismissed"]).optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateOpportunity(id, data);
        return { success: true };
      }),
  }),

  // ─── System Config ────────────────────────────────────────────────────────
  config: router({
    list: ownerProcedure.query(async () => {
      return getAllConfig();
    }),
    get: ownerProcedure
      .input(
        z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/) })
      )
      .query(async ({ input }) => {
        return getConfig(input.key);
      }),
    set: ownerProcedure
      .input(z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
        value: z.string().max(10_000),
        description: z.string().trim().max(1_000).optional(),
      }))
      .mutation(async ({ input }) => {
        await setConfig(input.key, input.value, input.description);
        return { success: true };
      }),
  }),

  // ─── Dashboard / Metrics ──────────────────────────────────────────────────
  metrics: router({
    today: ownerProcedure.query(async () => {
      return getTodayMetrics();
    }),
    recent: ownerProcedure
      .input(
        z.object({ days: z.number().int().min(1).max(366).default(30) }).optional()
      )
      .query(async ({ input }) => {
        return getRecentMetrics(input?.days || 30);
      }),
  }),

  // ─── System Health ────────────────────────────────────────────────────────
  health: router({
    status: ownerProcedure.query(async () => {
      const environmentGate = getLegacyWorkerEnvironmentGate();
      const runtimeGate = await getLegacyWorkerRuntimeGate();
      const storedSystemStatus = await getConfig("system_status") || "unknown";
      const callsToday = await getDailyCallCount();
      const emailsToday = await getDailyEmailCount();
      const maxCalls = parseInt(await getConfig("max_calls_per_day") || "20");
      const maxEmails = parseInt(await getConfig("max_emails_per_day") || "100");

      return {
        systemStatus: environmentGate.allowed ? storedSystemStatus : "retired",
        killSwitchActive: !runtimeGate.allowed,
        autonomyEnabled: runtimeGate.allowed,
        retirementReason: runtimeGate.allowed ? null : runtimeGate.reason,
        callsToday,
        maxCalls,
        emailsToday,
        maxEmails,
        timestamp: new Date().toISOString(),
      };
    }),
    toggleKillSwitch: ownerProcedure
      .input(z.object({ active: z.boolean() }))
      .mutation(async ({ input, ctx }) => {
        if (input.active) {
          await pauseLegacyWorker("Paused by verified owner in control panel");
        } else {
          try {
            await resumeLegacyWorkerByVerifiedOwner(ctx.user.openId);
          } catch (error) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: error instanceof Error ? error.message : "Legacy worker cannot be resumed",
            });
          }
        }
        return { success: true, killSwitchActive: input.active };
      }),
  }),
});

export type AppRouter = typeof appRouter;
