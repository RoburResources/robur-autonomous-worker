import { z } from "zod";
import { notifyOwner } from "./notification";
import { ownerProcedure, router } from "./trpc";

export const systemRouter = router({
  health: ownerProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: ownerProcedure
    .input(
      z.object({
        title: z.string().trim().min(1, "title is required").max(200),
        content: z.string().trim().min(1, "content is required").max(4_000),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
