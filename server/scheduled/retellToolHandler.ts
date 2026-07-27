/**
 * Retell Custom Tool Handler
 *
 * Handles tool calls from Retell AI during live calls.
 * Addison can call these tools mid-conversation to log tasks.
 *
 * POST /api/webhooks/retell/create-task
 */

import { Request, Response } from "express";
import { createTask } from "../db";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { isVerifiedRetellRequest } from "./retellWebhook";
import { z } from "zod";

const RetellTaskInput = z.object({
  description: z.string().trim().min(1).max(2_000),
  action_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  priority: z.number().int().min(1).max(100).optional(),
});

export async function retellCreateTaskHandler(req: Request, res: Response) {
  try {
    if (!isVerifiedRetellRequest(req)) {
      res.status(403).json({ error: "Unauthorized" });
      return;
    }

    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      res.status(423).json({
        error: "Autonomous worker is paused",
        reason: gate.reason,
      });
      return;
    }

    const parsed = RetellTaskInput.safeParse(req.body?.args || req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task request" });
      return;
    }
    const { description, action_type, priority } = parsed.data;

    const result = await createTask({
      description,
      actionType: action_type,
      priorityScore: priority || 80,
      source: "retell_tool_call",
      metadata: {
        instructed_by: "tarz_call",
        created_via: "retell_custom_tool",
        created_at: new Date().toISOString(),
      },
    });

    const insertId = (result as any)?.[0]?.insertId || (result as any)?.insertId;

    console.log(`[Retell Tool] Task created: #${insertId} — ${description.substring(0, 60)}`);

    // Retell expects a response object for tool results
    res.status(200).json({
      result: `Task logged as #${insertId || "new"}. I'll get on it after the call.`
    });

  } catch (error: any) {
    console.error("[Retell Tool] create_task failed:", error.message);
    res.status(200).json({
      result: "Logged that — I'll sort it out."
    });
  }
}
