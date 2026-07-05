import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  getAllGoals, getActiveGoals, createGoal, updateGoal,
  getRecentTasks, getTasksByStatus, updateTask, createTask,
  getRecentExecutions, getExecutionsForTask,
  getRecentEvaluations,
  getOpportunities, createOpportunity, updateOpportunity,
  getAllConfig, getConfig, setConfig,
  getRecentMetrics, getTodayMetrics,
  isKillSwitchActive, getDailyCallCount, getDailyEmailCount,
} from "./db";

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
    list: publicProcedure.query(async () => {
      return getAllGoals();
    }),
    active: publicProcedure.query(async () => {
      return getActiveGoals();
    }),
    create: protectedProcedure
      .input(z.object({
        goalText: z.string().min(1),
        priority: z.number().min(1).max(10).default(5),
        subGoals: z.array(z.string()).optional(),
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
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        goalText: z.string().optional(),
        status: z.enum(["active", "paused", "completed", "archived"]).optional(),
        priority: z.number().min(1).max(10).optional(),
        subGoals: z.array(z.string()).optional(),
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
    list: publicProcedure
      .input(z.object({ limit: z.number().default(100) }).optional())
      .query(async ({ input }) => {
        return getRecentTasks(input?.limit || 100);
      }),
    byStatus: publicProcedure
      .input(z.object({
        status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "awaiting_approval"]),
        limit: z.number().default(50),
      }))
      .query(async ({ input }) => {
        return getTasksByStatus(input.status, input.limit);
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled", "awaiting_approval"]).optional(),
        priorityScore: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateTask(id, data);
        return { success: true };
      }),
    create: protectedProcedure
      .input(z.object({
        description: z.string().min(1),
        actionType: z.string().default("web_research"),
        priorityScore: z.number().default(50),
        goalId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        await createTask({
          description: input.description,
          actionType: input.actionType,
          priorityScore: input.priorityScore,
          goalId: input.goalId,
          source: "manual",
          status: "pending",
        });
        return { success: true };
      }),
  }),

  // ─── Execution Log ────────────────────────────────────────────────────────
  executions: router({
    list: publicProcedure
      .input(z.object({ limit: z.number().default(100) }).optional())
      .query(async ({ input }) => {
        return getRecentExecutions(input?.limit || 100);
      }),
    forTask: publicProcedure
      .input(z.object({ taskId: z.number() }))
      .query(async ({ input }) => {
        return getExecutionsForTask(input.taskId);
      }),
  }),

  // ─── Evaluations ─────────────────────────────────────────────────────────
  evaluations: router({
    list: publicProcedure
      .input(z.object({ limit: z.number().default(50) }).optional())
      .query(async ({ input }) => {
        return getRecentEvaluations(input?.limit || 50);
      }),
  }),

  // ─── Opportunities ────────────────────────────────────────────────────────
  opportunities: router({
    list: publicProcedure
      .input(z.object({ limit: z.number().default(50) }).optional())
      .query(async ({ input }) => {
        return getOpportunities(input?.limit || 50);
      }),
    create: protectedProcedure
      .input(z.object({
        source: z.string(),
        description: z.string(),
        priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
        estimatedValue: z.string().optional(),
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
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
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
    list: publicProcedure.query(async () => {
      return getAllConfig();
    }),
    get: publicProcedure
      .input(z.object({ key: z.string() }))
      .query(async ({ input }) => {
        return getConfig(input.key);
      }),
    set: protectedProcedure
      .input(z.object({
        key: z.string(),
        value: z.string(),
        description: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await setConfig(input.key, input.value, input.description);
        return { success: true };
      }),
  }),

  // ─── Dashboard / Metrics ──────────────────────────────────────────────────
  metrics: router({
    today: publicProcedure.query(async () => {
      return getTodayMetrics();
    }),
    recent: publicProcedure
      .input(z.object({ days: z.number().default(30) }).optional())
      .query(async ({ input }) => {
        return getRecentMetrics(input?.days || 30);
      }),
  }),

  // ─── System Health ────────────────────────────────────────────────────────
  health: router({
    status: publicProcedure.query(async () => {
      const killSwitch = await isKillSwitchActive();
      const systemStatus = await getConfig("system_status") || "unknown";
      const callsToday = await getDailyCallCount();
      const emailsToday = await getDailyEmailCount();
      const maxCalls = parseInt(await getConfig("max_calls_per_day") || "20");
      const maxEmails = parseInt(await getConfig("max_emails_per_day") || "100");

      return {
        systemStatus,
        killSwitchActive: killSwitch,
        callsToday,
        maxCalls,
        emailsToday,
        maxEmails,
        timestamp: new Date().toISOString(),
      };
    }),
    toggleKillSwitch: protectedProcedure
      .input(z.object({ active: z.boolean() }))
      .mutation(async ({ input }) => {
        await setConfig("kill_switch_active", input.active ? "true" : "false");
        await setConfig("system_status", input.active ? "paused" : "active");
        return { success: true, killSwitchActive: input.active };
      }),
  }),
});

export type AppRouter = typeof appRouter;
