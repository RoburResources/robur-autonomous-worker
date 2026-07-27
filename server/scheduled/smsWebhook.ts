import { Request, Response } from "express";
import {
  isVerifiedOwnerSmsRequest,
  parseInboundSMS,
} from "../integrations/twilio";
import {
  claimInboundSms,
  getConfig,
  getTaskById,
  updateTask,
  logExecution,
} from "../db";
import { sendSMS } from "../integrations/twilio";
import {
  getLegacyWorkerRuntimeGate,
  pauseLegacyWorker,
  resumeLegacyWorkerByVerifiedOwner,
} from "../safety/legacyWorkerGate";
import { handleConversationalSMS } from "./smsConversation";

/**
 * SMS Webhook Handler
 * Receives inbound SMS from Twilio
 *
 * Handles two tiers:
 * 1. Structured commands (STOP, START, APPROVE, REJECT, STATUS) — safety controls
 * 2. Natural language instructions — routed to Addison's conversational handler
 *
 * POST /api/webhooks/sms
 */
export async function smsWebhookHandler(req: Request, res: Response) {
  try {
    if (!isVerifiedOwnerSmsRequest(req)) {
      res.status(403).send("<Response></Response>");
      return;
    }

    const { from, message, messageSid } = parseInboundSMS(req.body);

    if (!message || !(await claimInboundSms(messageSid))) {
      res.status(200).send("<Response></Response>");
      return;
    }

    const upperMessage = message.toUpperCase().trim();

    await logExecution({
      actionType: "inbound_sms",
      details: {
        messageClaimed: true,
        command: upperMessage.split(/\s+/, 1)[0],
        authenticatedOwner: true,
        messageLength: message.length,
      },
      outcome: "success",
    });

    // ── Structured safety commands ────────────────────────────────────────────

    // STOP kill switch
    if (upperMessage === "STOP") {
      await pauseLegacyWorker("Paused by verified owner via signed SMS");
      await sendSMS(from, "[Addison] Got it — system paused. Text START when you want me back on.");
      await logExecution({
        actionType: "kill_switch_activated",
        details: { triggeredBy: "verified_owner", method: "signed_sms" },
        outcome: "success",
      });
      res.status(200).send("<Response></Response>");
      return;
    }

    // START to resume
    if (upperMessage === "START") {
      try {
        await resumeLegacyWorkerByVerifiedOwner(`sms:${from}`);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Legacy worker is retired";
        await sendSMS(from, `[Addison] Can't resume right now: ${reason}.`);
        res.status(200).send("<Response></Response>");
        return;
      }
      await sendSMS(from, "[Addison] Back online! I'll pick up where I left off.");
      await logExecution({
        actionType: "kill_switch_deactivated",
        details: { triggeredBy: "verified_owner", method: "signed_sms" },
        outcome: "success",
      });
      res.status(200).send("<Response></Response>");
      return;
    }

    // APPROVE <id>
    if (upperMessage === "APPROVE" || upperMessage.startsWith("APPROVE ")) {
      const match = /^APPROVE\s+#?(\d+)$/.exec(upperMessage);
      if (!match) {
        await sendSMS(from, "[Addison] Which task? E.g. APPROVE 123");
        res.status(200).send("<Response></Response>");
        return;
      }
      const gate = await getLegacyWorkerRuntimeGate();
      if (!gate.allowed) {
        await sendSMS(from, `[Addison] Can't approve right now: ${gate.reason}.`);
        res.status(200).send("<Response></Response>");
        return;
      }
      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        await updateTask(task.id, { status: "pending" });
        await sendSMS(from, `[Addison] Task #${task.id} approved — on it: "${task.description.substring(0, 80)}"`);
        await logExecution({
          taskId: task.id,
          actionType: "approval_granted",
          details: { approvedBy: "verified_owner", taskId: task.id },
          outcome: "success",
        });
      } else {
        await sendSMS(from, `[Addison] Task #${match[1]} isn't waiting for approval.`);
      }
      res.status(200).send("<Response></Response>");
      return;
    }

    // REJECT <id>
    if (upperMessage === "REJECT" || upperMessage.startsWith("REJECT ")) {
      const match = /^REJECT\s+#?(\d+)$/.exec(upperMessage);
      if (!match) {
        await sendSMS(from, "[Addison] Which task? E.g. REJECT 123");
        res.status(200).send("<Response></Response>");
        return;
      }
      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        await updateTask(task.id, { status: "cancelled", resultSummary: "Rejected by Tarz via SMS" });
        await sendSMS(from, `[Addison] Task #${task.id} cancelled.`);
        await logExecution({
          taskId: task.id,
          actionType: "approval_rejected",
          details: { rejectedBy: "verified_owner", taskId: task.id },
          outcome: "success",
        });
      } else {
        await sendSMS(from, `[Addison] Task #${match[1]} isn't waiting for approval.`);
      }
      res.status(200).send("<Response></Response>");
      return;
    }

    // STATUS
    if (upperMessage === "STATUS") {
      const status = (await getConfig("system_status")) || "unknown";
      const gate = await getLegacyWorkerRuntimeGate();
      await sendSMS(
        from,
        `[Addison] System: ${status} | Autonomous: ${gate.allowed ? "running" : "blocked"}`
      );
      res.status(200).send("<Response></Response>");
      return;
    }

    // ── Natural language — route to Addison's conversational handler ──────────
    // Handles: TASKS, DONE, HELP, and any free-text instruction
    res.status(200).send("<Response></Response>"); // Respond to Twilio immediately
    // Process async so Twilio doesn't time out (15s limit)
    handleConversationalSMS(message, from).catch((err) => {
      console.error("[SMS Webhook] Conversational handler error:", err.message);
    });

  } catch (error: any) {
    console.error(
      "[SMS Webhook] Handler failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(500).send("<Response></Response>");
  }
}
