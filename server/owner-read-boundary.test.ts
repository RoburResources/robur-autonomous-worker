import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

function anonymousContext(): TrpcContext {
  return {
    user: null,
    req: { headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("owner-only dashboard reads", () => {
  it.each([
    ["goals.list", (caller: ReturnType<typeof appRouter.createCaller>) => caller.goals.list()],
    ["goals.active", (caller: ReturnType<typeof appRouter.createCaller>) => caller.goals.active()],
    ["tasks.list", (caller: ReturnType<typeof appRouter.createCaller>) => caller.tasks.list()],
    ["executions.list", (caller: ReturnType<typeof appRouter.createCaller>) => caller.executions.list()],
    ["evaluations.list", (caller: ReturnType<typeof appRouter.createCaller>) => caller.evaluations.list()],
    ["opportunities.list", (caller: ReturnType<typeof appRouter.createCaller>) => caller.opportunities.list()],
    ["metrics.today", (caller: ReturnType<typeof appRouter.createCaller>) => caller.metrics.today()],
    ["health.status", (caller: ReturnType<typeof appRouter.createCaller>) => caller.health.status()],
  ])("rejects anonymous access to %s", async (_name, invoke) => {
    const caller = appRouter.createCaller(anonymousContext());

    await expect(invoke(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each([
    [
      "tasks.create",
      (caller: ReturnType<typeof appRouter.createCaller>) =>
        caller.tasks.create({
          description: "Research official Western Australian planning guidance",
          actionType: "web_research",
          priorityScore: 80,
        }),
    ],
    [
      "tasks.run",
      (caller: ReturnType<typeof appRouter.createCaller>) =>
        caller.tasks.run({ id: 1 }),
    ],
  ])("rejects anonymous access to %s", async (_name, invoke) => {
    const caller = appRouter.createCaller(anonymousContext());

    await expect(invoke(caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
