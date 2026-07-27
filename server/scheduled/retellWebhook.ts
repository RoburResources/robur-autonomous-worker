/**
 * Retell AI Webhook Handler
 *
 * Handles post-call events from Retell AI:
 * - call_ended: Captures transcript, extracts instructions from Tarz, creates tasks
 * - call_analyzed: Stores call summary and sentiment
 *
 * POST /api/webhooks/retell
 */

import { Request, Response } from "express";
import { invokeLLM } from "../_core/llm";
import { sendSMS } from "../integrations/twilio";
import { createTask, logExecution, getConfig } from "../db";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

/**
 * Verify the Retell webhook signature.
 * Retell signs requests with a shared secret in the Authorization header.
 */
export function isVerifiedRetellRequest(req: Request): boolean {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) return false;
  const authHeader = req.headers["authorization"];
  // Retell sends: Authorization: <api_key>
  return authHeader === apiKey;
}

export async function retellWebhookHandler(req: Request, res: Response) {
  if (!isVerifiedRetellRequest(req)) {
    console.warn("[Retell Webhook] Unauthorized request");
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  const runtimeGate = await getLegacyWorkerRuntimeGate();
  if (!runtimeGate.allowed) {
    console.warn(
      `[Retell Webhook] Ignored while paused: ${runtimeGate.reason || "runtime gate denied"}`
    );
    res.status(200).json({ received: true, ignored: "worker_paused" });
    return;
  }

  // Respond immediately after authentication so Retell doesn't retry.
  res.status(200).json({ received: true });
  try {
    const event = req.body;
    const eventType = event?.event;

    console.log(`[Retell Webhook] Event: ${eventType}`);

    if (eventType === "call_ended" || eventType === "call_analyzed") {
      await handleCallEnded(event);
    }

  } catch (error: any) {
    console.error("[Retell Webhook] Handler error:", error.message);
  }
}

async function handleCallEnded(event: any): Promise<void> {
  const callId = event?.call?.call_id || event?.call_id;
  const agentId = event?.call?.agent_id || event?.agent_id;
  const transcript = event?.call?.transcript || event?.transcript || "";
  const callType = event?.call?.call_type || event?.call_type; // "inbound" or "outbound"
  const fromNumber = event?.call?.from_number || event?.from_number;
  const toNumber = event?.call?.to_number || event?.to_number;
  const durationMs = event?.call?.duration_ms || event?.duration_ms || 0;
  const disconnectionReason = event?.call?.disconnection_reason || event?.disconnection_reason;

  const userPhone = await getConfig("user_phone") || "+61495007200";
  const addisonAgentId = await getConfig("retell_agent_id") || "agent_7f02eb1896dd1e6deb38e54942";

  // Only process calls involving Addison's agent
  if (agentId !== addisonAgentId) {
    console.log(`[Retell Webhook] Ignoring call for agent ${agentId}`);
    return;
  }

  // Log the call
  await logExecution({
    actionType: callType === "inbound" ? "inbound_call_received" : "outbound_call_completed",
    details: {
      callId,
      agentId,
      fromNumber,
      toNumber,
      durationMs,
      disconnectionReason,
      transcriptLength: transcript.length,
    },
    outcome: durationMs > 5000 ? "success" : "partial",
  });

  // Only extract tasks from inbound calls from Tarz (or short calls with content)
  const isTarzCall = fromNumber === userPhone || toNumber === userPhone;
  if (!isTarzCall || transcript.length < 50) {
    console.log("[Retell Webhook] No task extraction needed for this call");
    return;
  }

  // Extract instructions from the transcript
  await extractTasksFromTranscript(transcript, callId, fromNumber === userPhone ? fromNumber : userPhone);
}

async function extractTasksFromTranscript(
  transcript: string,
  callId: string,
  replyTo: string
): Promise<void> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are extracting actionable tasks from a phone call transcript between Tarz (Michael) and Addison (his AI executive assistant).

Extract any instructions, requests, or tasks that Tarz gave Addison during the call.
Ignore small talk, confirmations, and Addison's responses.
Only extract clear, actionable items that need to be done.

For each task, determine:
- description: specific, executable description
- actionType: web_research / data_entry / outbound_call / send_email / send_sms
- priorityScore: 1-100
- estimatedValue: AUD revenue/cost impact (0 if unknown)

If there are no actionable tasks, return an empty array.`
        },
        {
          role: "user",
          content: `Call transcript:\n${transcript.substring(0, 3000)}\n\nExtract any tasks Tarz instructed Addison to do.`
        }
      ],
      outputSchema: {
        name: "call_tasks",
        schema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  actionType: { type: "string", enum: ["web_research", "data_entry", "outbound_call", "send_email", "send_sms"] },
                  priorityScore: { type: "number" },
                  estimatedValue: { type: "number" },
                },
                required: ["description", "actionType", "priorityScore"],
                additionalProperties: false,
              }
            },
            summary: { type: "string" }
          },
          required: ["tasks", "summary"],
          additionalProperties: false,
        }
      }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return;

    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const { tasks, summary } = parsed;

    if (!tasks || tasks.length === 0) {
      console.log("[Retell Webhook] No tasks extracted from call transcript");
      return;
    }

    // Create tasks
    const createdIds: number[] = [];
    for (const t of tasks) {
      const result = await createTask({
        description: t.description,
        actionType: t.actionType,
        priorityScore: t.priorityScore || 80,
        estimatedValue: t.estimatedValue?.toString(),
        source: "call_instruction",
        metadata: {
          instructed_by: "tarz_call",
          call_id: callId,
          extracted_at: new Date().toISOString(),
        },
      });
      const insertId = (result as any)?.[0]?.insertId || (result as any)?.insertId;
      if (insertId) createdIds.push(insertId);
    }

    // SMS confirmation to Tarz
    if (createdIds.length > 0) {
      const msg = createdIds.length === 1
        ? `[Addison] Logged that from our call — task #${createdIds[0]} added: "${tasks[0].description.substring(0, 80)}"`
        : `[Addison] Logged ${createdIds.length} tasks from our call: #${createdIds.join(", #")}. On it!`;
      await sendSMS(replyTo, msg.substring(0, 320));
    }

    console.log(`[Retell Webhook] Extracted ${createdIds.length} tasks from call ${callId}`);

  } catch (error: any) {
    console.error("[Retell Webhook] Task extraction failed:", error.message);
  }
}
