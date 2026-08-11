/**
 * Authenticated, durable Retell call-event ingestion.
 *
 * POST /api/webhooks/retell
 *
 * A verified event is first committed to the database and then acknowledged.
 * Processing happens from that durable inbox, so provider retries, process
 * restarts, and partial task creation cannot duplicate owner instructions.
 */

import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { invokeLLM } from "../_core/llm";
import { getRawJsonBody } from "../_core/rawBody";
import {
  applyRetellTaskCallback,
  createTaskOnce,
  getConfig,
  getTaskByExternalProviderReceipt,
  logExecutionOnce,
} from "../db";
import { isVerifiedRetellRequest } from "../integrations/retellWebhookAuth";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { unlockDependents } from "../autonomous/dagEngine";
import { externalApprovalArtifact } from "../safety/externalTaskApproval";
import { normalizeTaskMetadata } from "../autonomous/taskMetadata";
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";
import { recordVariantOutcome } from "../autonomous/abTesting";
import { storeContactInteraction } from "../memory/mem0";
import {
  claimRetellWebhook,
  completeRetellWebhook,
  enqueueRetellWebhook,
  listRetellWebhookInboxKeys,
  releaseRetellWebhookForRetry,
  stageRetellWebhookWorkProduct,
  type RetellInboxClaimResult,
} from "./retellWebhookInbox";

const RETELL_EVENT_TYPES = [
  "call_started",
  "call_ended",
  "call_analyzed",
] as const;
const RETELL_ACTION_TYPES = [
  "web_research",
  "data_entry",
  "outbound_call",
  "send_email",
  "send_sms",
] as const;

const retellEventSchema = z
  .object({
    event: z.enum(RETELL_EVENT_TYPES),
    call: z
      .object({
        call_id: z
          .string()
          .min(8)
          .max(160)
          .regex(/^[A-Za-z0-9_-]+$/),
        agent_id: z.string().min(8).max(160),
        agent_version: z.number().int().nonnegative().optional(),
        direction: z.enum(["inbound", "outbound"]).optional(),
        call_type: z.string().max(64).optional(),
        from_number: z.string().max(32).optional(),
        to_number: z.string().max(32).optional(),
        duration_ms: z.number().int().nonnegative().max(24 * 60 * 60_000).optional(),
        start_timestamp: z.number().int().nonnegative().optional(),
        end_timestamp: z.number().int().nonnegative().optional(),
        disconnection_reason: z.string().max(128).optional(),
        call_status: z.string().max(64).optional(),
        transcript: z.string().max(1_000_000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        call_analysis: z
          .object({
            call_summary: z.string().max(10_000).optional(),
            user_sentiment: z.string().max(500).optional(),
            call_successful: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const extractedTaskSchema = z
  .object({
    description: z.string().trim().min(10).max(4_000),
    actionType: z.enum(RETELL_ACTION_TYPES),
    priorityScore: z.number().int().min(1).max(100),
    estimatedValue: z.number().finite().min(0).max(10_000_000).optional(),
  })
  .strict();

const extractionSchema = z
  .object({
    tasks: z.array(extractedTaskSchema).max(3),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

const workProductSchema = z
  .object({
    disposition: z.enum([
      "recorded",
      "ignored_agent",
      "owner_instruction",
    ]),
    eventType: z.enum(RETELL_EVENT_TYPES),
    callId: z.string().min(8).max(160),
    agentId: z.string().min(8).max(160),
    agentVersion: z.number().int().nonnegative().optional(),
    direction: z.enum(["inbound", "outbound", "unknown"]),
    fromNumber: z.string().max(32),
    toNumber: z.string().max(32),
    durationMs: z.number().int().nonnegative().max(24 * 60 * 60_000),
    disconnectionReason: z.string().max(128),
    callStatus: z.string().max(64),
    externalDispatchId: z.string().max(64).optional(),
    callSuccessful: z.boolean().optional(),
    callSummary: z.string().max(2_000),
    userSentiment: z.string().max(128),
    correlatedTaskId: z.number().int().positive().optional(),
    correlatedTaskStatus: z
      .enum([
        "pending",
        "in_progress",
        "completed",
        "failed",
        "cancelled",
        "awaiting_approval",
      ])
      .optional(),
    callbackResolution: z
      .enum([
        "call_ended",
        "completed",
        "failed",
        "reconciliation_required",
      ])
      .optional(),
    tasks: z.array(extractedTaskSchema).max(3),
    summary: z.string().max(500),
  })
  .strict();

type RetellWorkProduct = z.infer<typeof workProductSchema>;
type AcquiredRetellClaim = Extract<
  RetellInboxClaimResult,
  { disposition: "acquired" }
>;

function channelCertified(): boolean {
  return process.env.RETELL_EVENT_WEBHOOK_CERTIFIED === "true";
}

function normalizeEventPayload(
  parsed: z.infer<typeof retellEventSchema>
): Record<string, unknown> {
  const call = parsed.call;
  return {
    event: parsed.event,
    call: {
      call_id: call.call_id,
      agent_id: call.agent_id,
      ...(call.agent_version === undefined
        ? {}
        : { agent_version: call.agent_version }),
      ...(call.direction ? { direction: call.direction } : {}),
      ...(call.call_type ? { call_type: call.call_type } : {}),
      ...(call.from_number ? { from_number: call.from_number } : {}),
      ...(call.to_number ? { to_number: call.to_number } : {}),
      ...(call.duration_ms === undefined
        ? {}
        : { duration_ms: call.duration_ms }),
      ...(call.start_timestamp === undefined
        ? {}
        : { start_timestamp: call.start_timestamp }),
      ...(call.end_timestamp === undefined
        ? {}
        : { end_timestamp: call.end_timestamp }),
      ...(call.disconnection_reason
        ? { disconnection_reason: call.disconnection_reason }
        : {}),
      ...(call.call_status ? { call_status: call.call_status } : {}),
      ...(call.transcript
        ? { transcript: call.transcript.slice(0, 20_000) }
        : {}),
      ...(call.metadata &&
      typeof call.metadata.external_dispatch_id === "string"
        ? {
            metadata: {
              external_dispatch_id:
                call.metadata.external_dispatch_id.slice(0, 64),
            },
          }
        : {}),
      ...(call.call_analysis
        ? {
            call_analysis: {
              ...(call.call_analysis.call_summary
                ? {
                    call_summary:
                      call.call_analysis.call_summary.slice(0, 2_000),
                  }
                : {}),
              ...(call.call_analysis.user_sentiment
                ? {
                    user_sentiment:
                      call.call_analysis.user_sentiment.slice(0, 128),
                  }
                : {}),
              ...(call.call_analysis.call_successful === undefined
                ? {}
                : {
                    call_successful:
                      call.call_analysis.call_successful,
                  }),
            },
          }
        : {}),
    },
  };
}

function durationFromCall(call: Record<string, unknown>): number {
  if (
    Number.isSafeInteger(call.duration_ms) &&
    Number(call.duration_ms) >= 0
  ) {
    return Number(call.duration_ms);
  }
  const start = Number(call.start_timestamp);
  const end = Number(call.end_timestamp);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start
    ? Math.min(end - start, 24 * 60 * 60_000)
    : 0;
}

async function extractOwnerTasks(
  transcript: string
): Promise<z.infer<typeof extractionSchema>> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `Extract Michael's clear, actionable instructions from this call transcript.
Ignore assistant speech, small talk, confirmations, and speculative ideas.
Return at most three tasks. External calls, emails, and SMS remain approval-gated downstream.`,
      },
      {
        role: "user",
        content: `Call transcript:\n${transcript.slice(0, 20_000)}`,
      },
    ],
    outputSchema: {
      name: "retell_owner_call_tasks",
      schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  minLength: 10,
                  maxLength: 4000,
                },
                actionType: {
                  type: "string",
                  enum: RETELL_ACTION_TYPES,
                },
                priorityScore: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                },
                estimatedValue: {
                  type: "number",
                  minimum: 0,
                  maximum: 10000000,
                },
              },
              required: ["description", "actionType", "priorityScore"],
              additionalProperties: false,
            },
          },
          summary: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["tasks", "summary"],
        additionalProperties: false,
      },
    },
  });
  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("Retell transcript extraction returned no content");
  return extractionSchema.parse(
    typeof content === "string" ? JSON.parse(content) : content
  );
}

async function buildWorkProduct(
  claim: AcquiredRetellClaim
): Promise<RetellWorkProduct> {
  const payload = claim.payload;
  const call =
    payload.call &&
    typeof payload.call === "object" &&
    !Array.isArray(payload.call)
      ? (payload.call as Record<string, unknown>)
      : null;
  if (!call) throw new Error("Durable Retell payload has no call object");

  const agentId = typeof call.agent_id === "string" ? call.agent_id : "";
  const agentVersion = Number.isSafeInteger(call.agent_version)
    ? Number(call.agent_version)
    : undefined;
  const configuredAgentId =
    (await getConfig("retell_executive_agent_id")) ||
    process.env.RETELL_EXECUTIVE_ASSISTANT_AGENT_ID ||
    "";
  if (!configuredAgentId) {
    throw new Error("Executive Retell agent identity is not configured");
  }

  const direction =
    call.direction === "inbound" || call.direction === "outbound"
      ? call.direction
      : "unknown";
  const fromNumber =
    typeof call.from_number === "string" ? call.from_number : "";
  const toNumber = typeof call.to_number === "string" ? call.to_number : "";
  const transcript =
    typeof call.transcript === "string" ? call.transcript : "";
  const disconnectionReason =
    typeof call.disconnection_reason === "string"
      ? call.disconnection_reason.slice(0, 128)
      : "";
  const callStatus =
    typeof call.call_status === "string" ? call.call_status.slice(0, 64) : "";
  const callMetadata =
    call.metadata &&
    typeof call.metadata === "object" &&
    !Array.isArray(call.metadata)
      ? (call.metadata as Record<string, unknown>)
      : {};
  const externalDispatchId =
    typeof callMetadata.external_dispatch_id === "string"
      ? callMetadata.external_dispatch_id.slice(0, 64)
      : undefined;
  const callAnalysis =
    call.call_analysis &&
    typeof call.call_analysis === "object" &&
    !Array.isArray(call.call_analysis)
      ? (call.call_analysis as Record<string, unknown>)
      : {};
  const callSuccessful =
    typeof callAnalysis.call_successful === "boolean"
      ? callAnalysis.call_successful
      : undefined;
  const callSummary =
    typeof callAnalysis.call_summary === "string"
      ? callAnalysis.call_summary.slice(0, 2_000)
      : "";
  const userSentiment =
    typeof callAnalysis.user_sentiment === "string"
      ? callAnalysis.user_sentiment.slice(0, 128)
      : "";
  const correlatedTask = await getTaskByExternalProviderReceipt(
    "retell",
    claim.callId
  );
  const correlatedTaskMetadata = normalizeTaskMetadata(
    correlatedTask?.metadata
  );
  const approvedArtifact = correlatedTask
    ? externalApprovalArtifact(correlatedTask)
    : null;
  const approvedIdentity =
    approvedArtifact?.providerIdentity.provider === "retell"
      ? approvedArtifact.providerIdentity
      : null;
  const correlationMatches =
    !correlatedTask ||
    (!!approvedArtifact &&
      !!approvedIdentity &&
      agentId === approvedIdentity.agentId &&
      agentVersion === approvedIdentity.agentVersion &&
      direction === "outbound" &&
      fromNumber === approvedIdentity.from &&
      toNumber === approvedArtifact.target &&
      !!externalDispatchId &&
      externalDispatchId === correlatedTaskMetadata.external_dispatch_id);
  const callbackResolution =
    !correlatedTask
      ? undefined
      : !correlationMatches
        ? "reconciliation_required"
        : claim.eventType === "call_ended"
          ? "call_ended"
          : claim.eventType === "call_analyzed"
            ? callSuccessful === true
              ? "completed"
              : callSuccessful === false
                ? "failed"
                : "reconciliation_required"
            : undefined;

  const base = {
    eventType: claim.eventType,
    callId: claim.callId,
    agentId,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    direction,
    fromNumber,
    toNumber,
    durationMs: durationFromCall(call),
    disconnectionReason,
    callStatus,
    ...(externalDispatchId ? { externalDispatchId } : {}),
    ...(callSuccessful === undefined ? {} : { callSuccessful }),
    callSummary,
    userSentiment,
    ...(correlatedTask?.id
      ? {
          correlatedTaskId: correlatedTask.id,
          correlatedTaskStatus: correlatedTask.status,
        }
      : {}),
    ...(callbackResolution ? { callbackResolution } : {}),
  } as const;

  if (agentId !== configuredAgentId) {
    return workProductSchema.parse({
      ...base,
      disposition: "ignored_agent",
      tasks: [],
      summary: "Ignored event for a different Retell agent",
    });
  }

  const ownerPhone =
    (await getConfig("user_phone")) || process.env.OWNER_PHONE_E164 || "";
  const isOwnerInstruction =
    claim.eventType === "call_ended" &&
    direction === "inbound" &&
    /^\+[1-9]\d{7,14}$/.test(ownerPhone) &&
    fromNumber === ownerPhone &&
    transcript.trim().length >= 50;

  if (!isOwnerInstruction) {
    return workProductSchema.parse({
      ...base,
      disposition: "recorded",
      tasks: [],
      summary: `Verified ${claim.eventType} event recorded`,
    });
  }

  const gate = await getLegacyWorkerRuntimeGate();
  if (!gate.allowed) {
    throw new Error(
      "Owner-call instruction extraction is deferred while autonomous execution is paused"
    );
  }
  const extraction = await extractOwnerTasks(transcript);
  return workProductSchema.parse({
    ...base,
    disposition: "owner_instruction",
    tasks: extraction.tasks,
    summary: extraction.summary,
  });
}

async function applyWorkProduct(
  claim: AcquiredRetellClaim,
  product: RetellWorkProduct
): Promise<void> {
  for (let index = 0; index < product.tasks.length; index += 1) {
    const task = product.tasks[index];
    await createTaskOnce(`retell:${claim.callId}:${claim.eventType}:${index}`, {
      description: task.description,
      actionType: task.actionType,
      priorityScore: task.priorityScore,
      estimatedValue: task.estimatedValue?.toString(),
      source: "call_instruction",
      metadata: {
        instructed_by: "verified_owner_call",
        retell_call_id: claim.callId,
        retell_event_type: claim.eventType,
      },
    });
  }

  await logExecutionOnce(
    `retell:${claim.callId}:${claim.eventType}:audit`,
    {
      ...(product.correlatedTaskId
        ? { taskId: product.correlatedTaskId }
        : {}),
      actionType: `retell_${claim.eventType}`,
      details: {
        callId: product.callId,
        agentId: product.agentId,
        direction: product.direction,
        durationMs: product.durationMs,
        disconnectionReason: product.disconnectionReason,
        callStatus: product.callStatus,
        disposition: product.disposition,
        createdTaskCount: product.tasks.length,
        summary: product.summary,
        authenticatedProvider: true,
      },
      outcome:
        product.disposition === "ignored_agent" ? "partial" : "success",
    }
  );

  if (
    product.correlatedTaskId &&
    product.callbackResolution &&
    product.correlatedTaskStatus === "in_progress"
  ) {
    const transition = await applyRetellTaskCallback(
      product.correlatedTaskId,
      product.callId,
      product.callbackResolution,
      {
        eventType:
          product.eventType === "call_analyzed"
            ? "call_analyzed"
            : "call_ended",
        ...(product.callSuccessful === undefined
          ? {}
          : { callSuccessful: product.callSuccessful }),
        ...(product.callSummary
          ? { callSummary: product.callSummary }
          : {}),
        ...(product.userSentiment
          ? { userSentiment: product.userSentiment }
          : {}),
        ...(product.disconnectionReason
          ? { disconnectionReason: product.disconnectionReason }
          : {}),
        ...(product.callStatus ? { callStatus: product.callStatus } : {}),
      }
    );
    let exactReplay = false;
    if (transition.outcome !== "updated") {
      const currentTask = await getTaskByExternalProviderReceipt(
        "retell",
        product.callId
      );
      const currentMetadata = normalizeTaskMetadata(currentTask?.metadata);
      const callbackKey =
        product.callbackResolution === "call_ended"
          ? "retell_call_ended"
          : "retell_terminal_callback";
      const storedCallback = currentMetadata[callbackKey];
      const expectedStatus =
        product.callbackResolution === "completed"
          ? "completed"
          : product.callbackResolution === "failed"
            ? "failed"
            : product.callbackResolution === "reconciliation_required"
              ? "awaiting_approval"
              : "in_progress";
      exactReplay =
        currentTask?.id === product.correlatedTaskId &&
        currentTask.status === expectedStatus &&
        !!storedCallback &&
        typeof storedCallback === "object" &&
        !Array.isArray(storedCallback) &&
        (storedCallback as Record<string, unknown>).eventType ===
          product.eventType &&
        (product.callbackResolution === "call_ended" ||
          currentMetadata.external_provider_terminal_pending === false);
      if (!exactReplay) {
        throw new Error(
          "Retell callback arrived before its exact provider-pending task fence was durable"
        );
      }
    }
    const terminalCompletionApplied =
      (transition.outcome === "updated" &&
        transition.status === "completed") ||
      (exactReplay && product.callbackResolution === "completed");
    if (terminalCompletionApplied) {
      const completedTask = await getTaskByExternalProviderReceipt(
        "retell",
        product.callId
      );
      const artifact = completedTask
        ? externalApprovalArtifact(completedTask)
        : null;
      if (completedTask && artifact?.actionType === "outbound_call") {
        if (artifact.experimentId && artifact.variantId) {
          await recordVariantOutcome({
            experimentId: artifact.experimentId,
            variantId: artifact.variantId,
            taskId: completedTask.id,
            success: true,
            confidenceScore: 1,
          });
        }
        const ownerPhone =
          (await getConfig("user_phone")) ||
          process.env.OWNER_PHONE_E164 ||
          "";
        if (artifact.target !== ownerPhone) {
          await storeContactInteraction({
            contactName: artifact.targetName || artifact.target,
            contactType: "supplier",
            channel: "phone",
            outcome: "connected",
            notes:
              product.callSummary || artifact.content.substring(0, 200),
            idempotencyKey: `retell:${product.callId}:task:${completedTask.id}:contact`,
          });
        }
      }
    }
    if (
      terminalCompletionApplied
    ) {
      await unlockDependents(product.correlatedTaskId);
    }
  }
}

export async function processRetellWebhookClaim(
  claim: AcquiredRetellClaim
): Promise<void> {
  try {
    const product = claim.workProduct
      ? workProductSchema.parse(claim.workProduct)
      : await buildWorkProduct(claim);
    const staged = await stageRetellWebhookWorkProduct(
      claim.key,
      claim.token,
      product
    );
    if (!staged) {
      throw new Error("Retell work product lost its durable processing fence");
    }
    await applyWorkProduct(claim, product);
    const completed = await completeRetellWebhook(claim.key, claim.token);
    if (!completed) {
      throw new Error("Retell webhook lost its durable completion fence");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const released = await releaseRetellWebhookForRetry(
      claim.key,
      claim.token,
      message
    );
    if (released.terminal) {
      await logExecutionOnce(`retell:${claim.key}:terminal-failure`, {
        actionType: "retell_webhook_terminal_failure",
        details: {
          inboxKey: claim.key,
          eventType: claim.eventType,
          attemptCount: claim.attemptCount,
        },
        outcome: "failure",
        errorMessage: message.slice(0, 500),
      }).catch(() => false);
    }
  }
}

export async function drainRetellWebhookInbox(options?: {
  eventKey?: string;
  maxEvents?: number;
}): Promise<number> {
  if (isPrivateCandidateInternalOnly() || !channelCertified()) return 0;

  const maxEvents = Math.max(1, Math.min(options?.maxEvents || 10, 25));
  const keys = options?.eventKey
    ? [options.eventKey]
    : await listRetellWebhookInboxKeys(maxEvents);
  let processed = 0;
  for (const key of keys.slice(0, maxEvents)) {
    const claim = await claimRetellWebhook(key);
    if (claim.disposition !== "acquired") continue;
    await processRetellWebhookClaim(claim);
    processed += 1;
  }
  return processed;
}

export function startRetellWebhookInboxWorker(): () => void {
  const run = () => {
    void drainRetellWebhookInbox().catch(error => {
      console.error(
        "[Retell Webhook] Inbox worker failed:",
        error instanceof Error ? error.message : "unknown error"
      );
    });
  };
  run();
  const timer = setInterval(run, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function retellWebhookHandler(req: Request, res: Response) {
  if (!channelCertified()) {
    res.status(404).send();
    return;
  }
  if (!isVerifiedRetellRequest(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rawBody = getRawJsonBody(req);
  if (rawBody === null) {
    res.status(400).json({ error: "Raw request body unavailable" });
    return;
  }
  let parsed: z.infer<typeof retellEventSchema>;
  try {
    parsed = retellEventSchema.parse(JSON.parse(rawBody));
  } catch {
    res.status(400).json({ error: "Invalid Retell event" });
    return;
  }

  const payloadDigest = createHash("sha256")
    .update(rawBody, "utf8")
    .digest("hex");
  try {
    const enqueued = await enqueueRetellWebhook(
      parsed.event,
      parsed.call.call_id,
      payloadDigest,
      normalizeEventPayload(parsed)
    );
    if (enqueued.disposition === "invalid") {
      res.status(400).json({ error: "Invalid Retell event" });
      return;
    }
    if (enqueued.disposition === "conflict") {
      await logExecutionOnce(
        `retell:${enqueued.key}:payload-conflict`,
        {
          actionType: "retell_webhook_payload_conflict",
          details: {
            inboxKey: enqueued.key,
            eventType: parsed.event,
            callId: parsed.call.call_id,
            authenticatedProvider: true,
          },
          outcome: "failure",
          errorMessage:
            "Authenticated Retell event identity was replayed with a different payload",
        }
      ).catch(() => false);
      res.status(409).json({ error: "Conflicting Retell event replay" });
      return;
    }

    res.status(204).send();
    if (enqueued.disposition === "accepted") {
      queueMicrotask(() => {
        void drainRetellWebhookInbox({
          eventKey: enqueued.key,
          maxEvents: 1,
        }).catch(error => {
          console.error(
            "[Retell Webhook] Deferred processing failed:",
            error instanceof Error ? error.message : "unknown error"
          );
        });
      });
    }
  } catch (error) {
    console.error(
      "[Retell Webhook] Durable enqueue failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(503).json({ error: "Webhook inbox unavailable" });
  }
}

export { isVerifiedRetellRequest };
