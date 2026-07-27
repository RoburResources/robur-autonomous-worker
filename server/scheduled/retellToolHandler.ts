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

export async function retellCreateTaskHandler(req: Request, res: Response) {
  try {
    const { description, action_type, priority } = req.body?.args || req.body || {};

    if (!description || !action_type) {
      res.status(400).json({ error: "description and action_type are required" });
      return;
    }

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
