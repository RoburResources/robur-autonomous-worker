/**
 * Durable conversational-SMS planning.
 *
 * Planning is side-effect free and is persisted by the SMS inbox before any
 * task is created. Replays apply that exact plan with stable task keys, so an
 * LLM retry can never create a second, different interpretation.
 */

import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { taskQueue } from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import {
  createTask,
  createTaskOnce,
  getConfig,
  getDb,
} from "../db";
import { sendSMS } from "../integrations/twilio";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

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

const conversationalTaskSchema = z
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
  .strict();

export const smsConversationPlanSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["reply_only", "task_creation"]),
    tasks: z.array(conversationalTaskSchema).max(3),
    reply: z.string().trim().min(1).max(320),
    fallback: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.kind === "task_creation" && value.tasks.length < 1) ||
      (value.kind === "reply_only" && value.tasks.length !== 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Conversation plan kind does not match its task count",
      });
    }
  });

export type SmsConversationPlan = z.infer<typeof smsConversationPlanSchema>;

class ConversationalRuntimeBlockedError extends Error {}

async function assertConversationalRuntimeAllowed(): Promise<void> {
  const gate = await getLegacyWorkerRuntimeGate();
  if (!gate.allowed) {
    throw new ConversationalRuntimeBlockedError(
      gate.reason || "Worker is paused"
    );
  }
}

function canonicalActionPayload(
  actionType: unknown,
  value: unknown
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (actionType !== "send_email") return payload;

  const email = [
    payload.email,
    payload.recipientEmail,
    payload.toEmail,
    payload.to,
  ].find(
    candidate => typeof candidate === "string" && candidate.trim().length > 0
  );
  return {
    ...(typeof email === "string" ? { email: email.trim() } : {}),
    ...(typeof payload.subject === "string" && payload.subject.trim()
      ? { subject: payload.subject.trim() }
      : {}),
  };
}

export function isStructuredCommand(message: string): boolean {
  const upper = message.toUpperCase().trim();
  return COMMAND_KEYWORDS.some(
    command => upper === command || upper.startsWith(`${command} `)
  );
}

function replyOnly(reply: string): SmsConversationPlan {
  return smsConversationPlanSchema.parse({
    version: 1,
    kind: "reply_only",
    tasks: [],
    reply,
    fallback: false,
  });
}

async function listTaskReply(status: "pending" | "completed"): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const query = db
    .select({
      id: taskQueue.id,
      desc: taskQueue.description,
      actionType: taskQueue.actionType,
    })
    .from(taskQueue)
    .where(eq(taskQueue.status, status))
    .orderBy(
      status === "pending"
        ? desc(taskQueue.priorityScore)
        : desc(taskQueue.completedAt)
    )
    .limit(5);
  const tasks = await query;
  if (tasks.length === 0) {
    return status === "pending"
      ? "[Addison] No pending tasks right now - the queue is clear."
      : "[Addison] Nothing has completed yet.";
  }
  const label =
    status === "pending" ? "pending tasks" : "recent completed tasks";
  const list = tasks
    .map(
      (task, index) =>
        `${index + 1}. #${task.id} [${task.actionType || "task"}] ${(task.desc || "").substring(0, 60)}`
    )
    .join("\n");
  return `[Addison] ${label}:\n${list}`.substring(0, 320);
}

/**
 * Produce one bounded, deterministic work product. This function performs no
 * task insert and sends no message.
 */
export async function planConversationalSMS(
  message: string
): Promise<SmsConversationPlan> {
  const normalized = message.trim();
  if (!normalized || normalized.length > 1_600) {
    throw new Error("SMS instruction is empty or exceeds 1,600 characters");
  }
  const upper = normalized.toUpperCase();
  if (upper === "TASKS" || upper === "QUEUE") {
    return replyOnly(await listTaskReply("pending"));
  }
  if (upper === "DONE" || upper === "COMPLETED") {
    return replyOnly(await listTaskReply("completed"));
  }
  if (upper === "HELP" || upper === "?") {
    return replyOnly(
      "[Addison] Commands: TASKS, DONE, STATUS, STOP, APPROVE <id>, REJECT <id>. Resume only from the authenticated owner dashboard. Or text an instruction naturally."
    );
  }

  try {
    await assertConversationalRuntimeAllowed();
    const constitution = (await getConfig("constitution")) || "";
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are Addison, Michael's private executive assistant at Robur Resources.
Convert the owner's SMS into 1-3 specific tasks.

CONTEXT:
${constitution.substring(0, 500)}

Allowed actionType values: web_research, data_entry, outbound_call, send_email, send_sms.
For external actions include only the target fields stated by the owner.
Return the requested JSON and keep the reply under 240 characters.`,
        },
        {
          role: "user",
          content: `Owner SMS instruction: ${JSON.stringify(normalized)}`,
        },
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
                  description: {
                    type: "string",
                    minLength: 10,
                    maxLength: 4_000,
                  },
                  actionType: {
                    type: "string",
                    enum: CONVERSATIONAL_ACTION_TYPES,
                  },
                  priorityScore: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                  },
                  estimatedValue: {
                    type: "number",
                    minimum: 0,
                    maximum: 10_000_000,
                  },
                  actionPayload: {
                    type: "object",
                    maxProperties: 10,
                    additionalProperties: {
                      anyOf: [
                        { type: "string", maxLength: 4_000 },
                        { type: "number" },
                        { type: "boolean" },
                        { type: "null" },
                      ],
                    },
                  },
                },
                required: ["description", "actionType", "priorityScore"],
                additionalProperties: false,
              },
            },
            reply: { type: "string", minLength: 1, maxLength: 240 },
          },
          required: ["tasks", "reply"],
          additionalProperties: false,
        },
      },
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("No LLM response");
    const parsed =
      typeof content === "string" ? JSON.parse(content) : content;
    return smsConversationPlanSchema.parse({
      version: 1,
      kind: "task_creation",
      tasks: parsed.tasks,
      reply: parsed.reply,
      fallback: false,
    });
  } catch (error) {
    if (error instanceof ConversationalRuntimeBlockedError) throw error;
    return smsConversationPlanSchema.parse({
      version: 1,
      kind: "task_creation",
      tasks: [
        {
          description: `[From Tarz SMS] ${normalized}`,
          actionType: "web_research",
          priorityScore: 85,
        },
      ],
      reply: "Got it. I recorded that instruction for safe processing.",
      fallback: true,
    });
  }
}

/**
 * Apply an already-persisted plan. Every task in a provider delivery shares
 * the same key namespace, including deterministic fallback plans.
 */
export async function applyConversationalSmsPlan(
  planValue: SmsConversationPlan,
  message: string,
  idempotencyKey?: string
): Promise<string> {
  const plan = smsConversationPlanSchema.parse(planValue);
  if (plan.tasks.length > 0) {
    await assertConversationalRuntimeAllowed();
  }
  const createdIds: number[] = [];
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const task = plan.tasks[index];
    const input = {
      description: task.description,
      actionType: task.actionType,
      priorityScore: task.priorityScore,
      estimatedValue: task.estimatedValue?.toString(),
      actionPayload: canonicalActionPayload(
        task.actionType,
        task.actionPayload
      ),
      source: "sms_instruction",
      metadata: {
        instructed_by: "verified_owner_sms",
        original_message: message.substring(0, 200),
      },
    };
    if (idempotencyKey) {
      const result = await createTaskOnce(
        `${idempotencyKey}:task:${index}`,
        input
      );
      if (result.taskId) createdIds.push(result.taskId);
    } else {
      const result = await createTask(input);
      const driverResult = (result as any)?.[0] ?? result;
      const taskId = Number(driverResult?.insertId);
      if (Number.isSafeInteger(taskId) && taskId > 0) createdIds.push(taskId);
    }
  }
  if (plan.kind === "reply_only") return plan.reply;
  const suffix =
    createdIds.length === 1
      ? ` (Task #${createdIds[0]} recorded)`
      : createdIds.length > 1
        ? ` (${createdIds.length} tasks recorded)`
        : " (Instruction already recorded)";
  return `[Addison] ${plan.reply}${suffix}`.substring(0, 320);
}

/**
 * Backward-compatible direct entry point. The webhook uses the durable inbox
 * path below this layer; tests and internal callers can still use this helper.
 */
export async function handleConversationalSMS(
  message: string,
  from: string,
  idempotencyKey?: string
): Promise<void> {
  try {
    await assertConversationalRuntimeAllowed();
    const plan = await planConversationalSMS(message);
    const reply = await applyConversationalSmsPlan(
      plan,
      message,
      idempotencyKey
    );
    await assertConversationalRuntimeAllowed();
    try {
      await sendSMS(from, reply);
    } catch (error) {
      console.error(
        "[SMS Conversation] Confirmation reply failed after durable task work:",
        error instanceof Error ? error.message : "unknown error"
      );
    }
  } catch (error) {
    if (error instanceof ConversationalRuntimeBlockedError) return;
    throw error;
  }
}
