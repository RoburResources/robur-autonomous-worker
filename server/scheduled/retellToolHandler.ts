/**
 * Retell custom-function handler used during an executive call.
 *
 * POST /api/webhooks/retell/create-task
 */

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { getRawJsonBody } from "../_core/rawBody";
import {
  createTaskOnce,
  getConfig,
  getTaskByExternalProviderReceipt,
} from "../db";
import { getRetellCall } from "../integrations/retell";
import { isVerifiedRetellRequest } from "../integrations/retellWebhookAuth";
import { normalizeTaskMetadata } from "../autonomous/taskMetadata";
import { externalApprovalArtifact } from "../safety/externalTaskApproval";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

const RetellTaskInput = z
  .object({
    name: z.string().min(1).max(128).optional(),
    call: z
      .object({
        call_id: z
          .string()
          .min(8)
          .max(160)
          .regex(/^[A-Za-z0-9_-]+$/),
        agent_id: z.string().min(8).max(160),
        direction: z.enum(["inbound", "outbound"]),
        from_number: z.string().max(32).optional(),
        to_number: z.string().max(32).optional(),
      })
      .passthrough(),
    args: z
      .object({
        description: z.string().trim().min(10).max(2_000),
        action_type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        priority: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
  })
  .passthrough();

export async function retellCreateTaskHandler(req: Request, res: Response) {
  try {
    if (process.env.RETELL_CUSTOM_TOOL_CHANNEL_CERTIFIED !== "true") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!isVerifiedRetellRequest(req)) {
      res.status(401).json({ error: "Unauthorized" });
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

    const rawBody = getRawJsonBody(req);
    let decoded: unknown = null;
    try {
      decoded = rawBody === null ? null : JSON.parse(rawBody);
    } catch {
      decoded = null;
    }
    const parsed = RetellTaskInput.safeParse(decoded);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task request" });
      return;
    }

    const { call, args } = parsed.data;
    const configuredAgentId =
      (await getConfig("retell_executive_agent_id")) ||
      process.env.RETELL_EXECUTIVE_ASSISTANT_AGENT_ID ||
      "";
    const ownerPhone =
      (await getConfig("user_phone")) || process.env.OWNER_PHONE_E164 || "";
    const ownerCall =
      call.direction === "outbound" && call.to_number === ownerPhone;
    if (
      !configuredAgentId ||
      call.agent_id !== configuredAgentId ||
      !/^\+[1-9]\d{7,14}$/.test(ownerPhone) ||
      !ownerCall
    ) {
      res.status(403).json({ error: "Owner call identity required" });
      return;
    }

    const providerCall = await getRetellCall(call.call_id);
    const correlatedTask = await getTaskByExternalProviderReceipt(
      "retell",
      call.call_id
    );
    const artifact = correlatedTask
      ? externalApprovalArtifact(correlatedTask)
      : null;
    const identity =
      artifact?.actionType === "outbound_call" &&
      artifact.providerIdentity.provider === "retell"
        ? artifact.providerIdentity
        : null;
    const correlatedMetadata = normalizeTaskMetadata(
      correlatedTask?.metadata
    );
    const configuredVersion = Number(
      process.env.RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION
    );
    if (
      !correlatedTask ||
      correlatedTask.status !== "in_progress" ||
      !identity ||
      !Number.isSafeInteger(configuredVersion) ||
      configuredVersion < 0 ||
      providerCall.callStatus !== "ongoing" ||
      providerCall.callId !== call.call_id ||
      providerCall.agentId !== call.agent_id ||
      providerCall.agentVersion !== configuredVersion ||
      identity.agentId !== providerCall.agentId ||
      identity.agentVersion !== providerCall.agentVersion ||
      providerCall.direction !== call.direction ||
      providerCall.fromNumber !== (call.from_number || "") ||
      providerCall.toNumber !== (call.to_number || "") ||
      identity.from !== providerCall.fromNumber ||
      artifact?.target !== providerCall.toNumber ||
      !providerCall.externalDispatchId ||
      providerCall.externalDispatchId !==
        correlatedMetadata.external_dispatch_id
    ) {
      res.status(403).json({ error: "Owner call identity required" });
      return;
    }

    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          callId: call.call_id,
          description: args.description,
          actionType: args.action_type,
          priority: args.priority || 80,
        }),
        "utf8"
      )
      .digest("hex");
    const result = await createTaskOnce(`retell-tool:${requestDigest}`, {
      description: args.description,
      actionType: args.action_type,
      priorityScore: args.priority || 80,
      source: "retell_tool_call",
      metadata: {
        instructed_by: "verified_owner_call",
        created_via: "retell_custom_tool",
        retell_call_id: call.call_id,
      },
    });

    res.status(200).json({
      result: result.created
        ? `Task logged as #${result.taskId || "new"}. I'll get on it after the call.`
        : "That exact task was already logged.",
    });
  } catch (error) {
    console.error(
      "[Retell Tool] create_task failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(500).json({ error: "Task could not be logged" });
  }
}
