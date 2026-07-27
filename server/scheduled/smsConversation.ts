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
  getDb,
} from "../db";
import { taskQueue } from "../../drizzle/schema";
import { eq, desc, sql } from "drizzle-orm";

const COMMAND_KEYWORDS = ["STOP", "START", "APPROVE", "REJECT", "STATUS"];

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
  from: string
): Promise<void> {
  const upper = message.toUpperCase().trim();

  // TASKS — list pending tasks
  if (upper === "TASKS" || upper === "QUEUE") {
    const db = await getDb();
    if (!db) {
      await sendSMS(from, "[Addison] Can't reach database right now, try again in a sec.");
      return;
    }
    const tasks = await db
      .select({ id: taskQueue.id, desc: taskQueue.description, actionType: taskQueue.actionType, score: taskQueue.priorityScore })
      .from(taskQueue)
      .where(eq(taskQueue.status, "pending"))
      .orderBy(desc(taskQueue.priorityScore))
      .limit(5);

    if (tasks.length === 0) {
      await sendSMS(from, "[Addison] No pending tasks right now — queue's clear!");
      return;
    }
    const list = tasks.map((t, i) =>
      `${i + 1}. #${t.id} [${t.actionType}] ${t.desc?.substring(0, 60)}...`
    ).join("\n");
    await sendSMS(from, `[Addison] Top ${tasks.length} pending tasks:\n${list}`);
    return;
  }

  // DONE — list recent completed tasks
  if (upper === "DONE" || upper === "COMPLETED") {
    const db = await getDb();
    if (!db) {
      await sendSMS(from, "[Addison] Can't reach database right now.");
      return;
    }
    const tasks = await db
      .select({ id: taskQueue.id, desc: taskQueue.description, actionType: taskQueue.actionType })
      .from(taskQueue)
      .where(eq(taskQueue.status, "completed"))
      .orderBy(desc(taskQueue.completedAt))
      .limit(5);

    if (tasks.length === 0) {
      await sendSMS(from, "[Addison] Nothing completed yet — still working through the queue.");
      return;
    }
    const list = tasks.map((t, i) =>
      `${i + 1}. #${t.id} [${t.actionType}] ${t.desc?.substring(0, 60)}...`
    ).join("\n");
    await sendSMS(from, `[Addison] Last ${tasks.length} completed:\n${list}`);
    return;
  }

  // HELP — show available commands
  if (upper === "HELP" || upper === "?") {
    await sendSMS(from,
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
  await handleNaturalLanguageInstruction(message, from);
}

/**
 * Parse a free-text instruction from Tarz and create one or more tasks.
 */
async function handleNaturalLanguageInstruction(
  message: string,
  from: string
): Promise<void> {
  try {
    // Get context for the LLM
    const constitution = await getConfig("constitution") || "";
    const userPhone = await getConfig("user_phone") || "+61495007200";

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
- For send_email tasks, include recipientEmail and subject in actionPayload if mentioned
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
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  actionType: { type: "string", enum: ["web_research", "data_entry", "outbound_call", "send_email", "send_sms"] },
                  priorityScore: { type: "number" },
                  estimatedValue: { type: "number" },
                  actionPayload: { type: "object" },
                },
                required: ["description", "actionType", "priorityScore"],
                additionalProperties: false,
              }
            },
            reply: { type: "string" }
          },
          required: ["tasks", "reply"],
          additionalProperties: false,
        }
      }
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("No LLM response");

    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const { tasks, reply } = parsed;

    // Create each task
    const createdIds: number[] = [];
    for (const t of tasks || []) {
      const result = await createTask({
        description: t.description,
        actionType: t.actionType,
        priorityScore: t.priorityScore || 80,
        estimatedValue: t.estimatedValue?.toString(),
        actionPayload: t.actionPayload || null,
        source: "sms_instruction",
        metadata: {
          instructed_by: "tarz_sms",
          original_message: message.substring(0, 200),
          created_at: new Date().toISOString(),
        },
      });
      const insertId = (result as any)?.[0]?.insertId || (result as any)?.insertId;
      if (insertId) createdIds.push(insertId);
    }

    // Send confirmation reply
    const taskCount = createdIds.length;
    const confirmText = taskCount === 1
      ? `[Addison] ${reply} (Task #${createdIds[0]} added)`
      : `[Addison] ${reply} (${taskCount} tasks added: #${createdIds.join(", #")})`;

    await sendSMS(from, confirmText.substring(0, 320));

  } catch (error: any) {
    console.error("[SMS Conversation] NL instruction failed:", error.message);
    // Fallback: create a generic web_research task
    try {
      const result = await createTask({
        description: `[From Tarz SMS] ${message}`,
        actionType: "web_research",
        priorityScore: 85,
        source: "sms_instruction",
        metadata: { instructed_by: "tarz_sms", original_message: message.substring(0, 200) },
      });
      const insertId = (result as any)?.[0]?.insertId || (result as any)?.insertId;
      await sendSMS(from, `[Addison] Got it${insertId ? `, logged as task #${insertId}` : ""}. I'll get on it.`);
    } catch (fallbackError: any) {
      await sendSMS(from, "[Addison] Something went wrong logging that — try again in a sec.");
    }
  }
}
