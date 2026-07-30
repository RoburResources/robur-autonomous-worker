/**
 * Conversational SMS Handler for Addison
 *
 * Handles natural language instructions from Tarz via SMS.
 * Parses free-text messages using LLM, creates tasks, and replies with confirmation.
 *
 * Supported patterns:
 *   - Any free-text instruction → LLM parses intent, creates task(s), replies with summary
 *   - "TASKS" → list top 5 pending tasks
 *   - "DONE" → list last 5 completed tasks
 *   - "STATUS" → system status (handled by existing webhook)
 *   - "STOP/START/APPROVE/REJECT" → handled by existing webhook
 */

import { invokeLLM } from "../_core/llm";
import { sendSMS } from "../integrations/twilio";
import {
  getConfig,
  createTask,
  createTaskOnce,
  getDb,
} from "../db";
import { taskQueue } from "../../drizzle/schema";
import { eq, desc, sql } from "drizzle-orm";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";
import { z } from "zod";

const COMMAND_KEYWORDS = ["STOP", "START", "APPROVE", "REJECT", "STATUS"];
const CONVERSATIONAL_ACTION_TYPES = [
  "web_research",
  "data_entry",
  "outbound_call",
  "send_email",
  "send_sms",
] as const;
const conversationalActionPayloadSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([
      z.string().max(4_000),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ])
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Action payload has too many fields",
      });
    }
  });
const conversationalInstructionSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            description: z.string().trim().min(10).max(4_000),
            actionType: z.enum(CONVERSATIONAL_ACTION_TYPES),
            priorityScore: z.number().int().min(1).max(100),
            estimatedValue: z
              .number()
              .finite()
              .min(0)
              .max(10_000_000)
              .optional(),
            actionPayload: conversationalActionPayloadSchema.optional(),
          })
          .strict()
      )
      .min(1)
      .max(3),
    reply: z.string().trim().min(1).max(240),
  })
  .strict();

class ConversationalRuntimeBlockedError extends Error {}

async function assertConversationalRuntimeAllowed(): Promise<void> {
  const gate = await getLegacyWorkerRuntimeGate();
  if (!gate.allowed) {
    throw new ConversationalRuntimeBlockedError(
      gate.reason || "Worker is paused"
    );
  }
}

async function sendConversationalReply(
  to: string,
  body: string
): Promise<void> {
  await assertConversationalRuntimeAllowed();
  await sendSMS(to, body);
}

async function createConversationalTask(
  task: Parameters<typeof createTask>[0],
  idempotencyKey?: string
) {
  await assertConversationalRuntimeAllowed();
  return idempotencyKey
    ? createTaskOnce(idempotencyKey, task)
    : createTask(task);
}

function canonicalActionPayload(
  actionType: unknown,
  value: unknown
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (actionType !== "send_email") return payload;

  const emailCandidates = [
    payload.email,
    payload.recipientEmail,
    payload.toEmail,
    payload.to,
  ];
  const email = emailCandidates.find(
    candidate => typeof candidate === "string" && candidate.trim().length > 0
  );
  return {
    ...(typeof email === "string" ? { email: email.trim() } : {}),
    ...(typeof payload.subject === "string" && payload.subject.trim()
      ? { subject: payload.subject.trim() }
      : {}),
  };
}

/**
 * Returns true if the message is a structured command handled by the existing webhook.
 */
export function isStructuredCommand(message: string): boolean {
  const upper = message.toUpperCase().trim();
  return COMMAND_KEYWORDS.some(
    (cmd) => upper === cmd || upper.startsWith(cmd + " ")
  );
}

/**
 * Handle a natural language SMS from the verified owner.
 * Returns the reply text to send back.
 */
export async function handleConversationalSMS(
  message: string,
  from: string,
  idempotencyKey?: string
): Promise<void> {
  try {
    await assertConversationalRuntimeAllowed();
  } catch (error) {
    if (error instanceof ConversationalRuntimeBlockedError) return;
    throw error;
  }
  const upper = message.toUpperCase().trim();

  // TASKS — list pending tasks
  if (upper === "TASKS" || upper === "QUEUE") {
    const db = await getDb();
    if (!db) {
      await sendConversationalReply(from, "[Addison] Can't reach database right now, try again in a sec.");
      return;
    }
    const tasks = await db
      .select({ id: taskQueue.id, desc: taskQueue.description, actionType: taskQueue.actionType, score: taskQueue.priorityScore })
      .from(taskQueue)
      .where(eq(taskQueue.status, "pending"))
      .orderBy(desc(taskQueue.priorityScore))
      .limit(5);

    if (tasks.length === 0) {
      await sendConversationalReply(from, "[Addison] No pending tasks right now — queue's clear!");
      return;
    }
    const list = tasks.map((t, i) =>
      `${i + 1}. #${t.id} [${t.actionType}] ${t.desc?.substring(0, 60)}...`
    ).join("\n");
    await sendConversationalReply(from, `[Addison] Top ${tasks.length} pending tasks:\n${list}`);
    return;
  }

  // DONE — list recent completed tasks
  if (upper === "DONE" || upper === "COMPLETED") {
    const db = await getDb();
    if (!db) {
      await sendConversationalReply(from, "[Addison] Can't reach database right now.");
      return;
    }
    const tasks = await db
      .select({ id: taskQueue.id, desc: taskQueue.description, actionType: taskQueue.actionType })
      .from(taskQueue)
      .where(eq(taskQueue.status, "completed"))
      .orderBy(desc(taskQueue.completedAt))
      .limit(5);

    if (tasks.length === 0) {
      await sendConversationalReply(from, "[Addison] Nothing completed yet — still working through the queue.");
      return;
    }
    const list = tasks.map((t, i) =>
      `${i + 1}. #${t.id} [${t.actionType}] ${t.desc?.substring(0, 60)}...`
    ).join("\n");
    await sendConversationalReply(from, `[Addison] Last ${tasks.length} completed:\n${list}`);
    return;
  }

  // HELP — show available commands
  if (upper === "HELP" || upper === "?") {
    await sendConversationalReply(from,
      "[Addison] Commands:\n" +
      "TASKS — see pending queue\n" +
      "DONE — see completed tasks\n" +
      "STATUS — system status\n" +
      "STOP / START — kill switch\n" +
      "APPROVE/REJECT <id> — task approval\n" +
      "Or just text me an instruction naturally!"
    );
    return;
  }

  // Natural language instruction — parse with LLM and create task(s)
  await handleNaturalLanguageInstruction(message, from, idempotencyKey);
}

/**
 * Parse a free-text instruction from Tarz and create one or more tasks.
 */
async function handleNaturalLanguageInstruction(
  message: string,
  from: string,
  idempotencyKey?: string
): Promise<void> {
  const createdIds: number[] = [];
  let committedTaskCount = 0;
  try {
    // Get context for the LLM
    const constitution = await getConfig("constitution") || "";
    const userPhone = await getConfig("user_phone") || "+61495007200";

    await assertConversationalRuntimeAllowed();
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are Addison, the AI executive assistant for Tarz (Michael) at Robur Resources (scrap metal recycling, Perth WA).
Tarz has sent you an SMS instruction. Parse it and create 1-3 actionable tasks.

CONTEXT:
${constitution.substring(0, 500)}

TASK CREATION RULES:
- Each task must have: description (specific, actionable), actionType (web_research/data_entry/outbound_call/send_email/send_sms), priorityScore (1-100), estimatedValue (AUD revenue/cost impact)
- For outbound_call tasks, include phoneNumber in actionPayload if mentioned
- For send_email tasks, include email and subject in actionPayload if mentioned
- For send_sms tasks, include phoneNumber and message in actionPayload if mentioned
- Keep descriptions specific and executable

Respond with JSON: { "tasks": [...], "reply": "brief confirmation SMS reply (1-2 sentences, casual Australian tone)" }`
        },
        {
          role: "user",
          content: `Tarz's SMS instruction: "${message}"\n\nCreate the appropriate task(s) and draft a brief reply.`
        }
      ],
      outputSchema: {
        name: "task_creation",
        schema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  description: { type: "string", minLength: 10, maxLength: 4000 },
                  actionType: { type: "string", enum: CONVERSATIONAL_ACTION_TYPES },
                  priorityScore: { type: "integer", minimum: 1, maximum: 100 },
                  estimatedValue: { type: "number", minimum: 0, maximum: 10000000 },
                  actionPayload: {
                    type: "object",
                    maxProperties: 10,
                    additionalProperties: {
                      anyOf: [
                        { type: "string", maxLength: 4000 },
                        { type: "number" },
                        { type: "boolean" },
                        { type: "null" },
                      ],
                    },
                  },
                },
                required: ["description", "actionType", "priorityScore"],
                additionalProperties: false,
              }
            },
            reply: { type: "string", minLength: 1, maxLength: 240 }
          },
          required: ["tasks", "reply"],
          additionalProperties: false,
        }
      }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("No LLM response");

    const parsed = conversationalInstructionSchema.parse(
      typeof content === "string" ? JSON.parse(content) : content
    );
    const { tasks, reply } = parsed;

    // Create each task
    for (let index = 0; index < (tasks || []).length; index += 1) {
      const t = tasks[index];
      const result = await createConversationalTask({
        description: t.description,
        actionType: t.actionType,
        priorityScore: t.priorityScore,
        estimatedValue: t.estimatedValue?.toString(),
        actionPayload: canonicalActionPayload(t.actionType, t.actionPayload),
        source: "sms_instruction",
        metadata: {
          instructed_by: "tarz_sms",
          original_message: message.substring(0, 200),
          created_at: new Date().toISOString(),
        },
      }, idempotencyKey ? `${idempotencyKey}:task:${index}` : undefined);
      const onceResult =
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        "created" in result
          ? (result as { created: boolean; taskId?: number })
          : null;
      if (onceResult) committedTaskCount += 1;
      const insertId =
        onceResult?.taskId ||
        (result as any)?.[0]?.insertId ||
        (result as any)?.insertId;
      if (insertId) createdIds.push(insertId);
    }

    // Send confirmation reply
    const taskCount = createdIds.length || committedTaskCount;
    const confirmText = createdIds.length === 0 && committedTaskCount > 0
      ? `[Addison] ${reply} (${committedTaskCount} task${committedTaskCount === 1 ? "" : "s"} already recorded)`
      : taskCount === 1
      ? `[Addison] ${reply} (Task #${createdIds[0]} added)`
      : `[Addison] ${reply} (${taskCount} tasks added: #${createdIds.join(", #")})`;

    await sendConversationalReply(from, confirmText.substring(0, 320));

  } catch (error: any) {
    if (error instanceof ConversationalRuntimeBlockedError) return;
    console.error("[SMS Conversation] NL instruction failed:", error.message);
    if (createdIds.length > 0 || committedTaskCount > 0) {
      console.error(
        "[SMS Conversation] Task creation committed; fallback suppressed to prevent duplication"
      );
      return;
    }
    // Fallback: create a generic web_research task
    try {
      const result = await createConversationalTask({
        description: `[From Tarz SMS] ${message}`,
        actionType: "web_research",
        priorityScore: 85,
        source: "sms_instruction",
        metadata: { instructed_by: "tarz_sms", original_message: message.substring(0, 200) },
      }, idempotencyKey ? `${idempotencyKey}:fallback` : undefined);
      const insertId =
        (result as any)?.taskId ||
        (result as any)?.[0]?.insertId ||
        (result as any)?.insertId;
      await sendConversationalReply(from, `[Addison] Got it${insertId ? `, logged as task #${insertId}` : ""}. I'll get on it.`);
    } catch (fallbackError: any) {
      if (fallbackError instanceof ConversationalRuntimeBlockedError) return;
      await sendConversationalReply(from, "[Addison] Something went wrong logging that — try again in a sec.");
    }
  }
}
