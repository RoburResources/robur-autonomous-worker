import { Request, Response } from "express";
import {
  isVerifiedOwnerSmsRequest,
  parseInboundSMS,
} from "../integrations/twilio";
import {
  acquireInboundSms,
  completeInboundSms,
  getConfig,
  getTaskById,
  updateTaskByOwnerWithAudit,
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
    if (process.env.OWNER_SMS_COMMAND_CHANNEL_CERTIFIED !== "true") {
      res.status(404).send("<Response></Response>");
      return;
    }
    if (!isVerifiedOwnerSmsRequest(req)) {
      res.status(403).send("<Response></Response>");
      return;
    }

    const { from, message, messageSid } = parseInboundSMS(req.body);

    if (!message) {
      res.status(200).send("<Response></Response>");
      return;
    }

    const upperMessage = message.toUpperCase().trim();
    const lease = await acquireInboundSms(messageSid);
    if (lease.disposition === "invalid") {
      res.status(400).send("<Response></Response>");
      return;
    }
    if (lease.disposition === "completed") {
      res.status(200).send("<Response></Response>");
      return;
    }
    if (lease.disposition === "processing") {
      // STOP is an idempotent safety action. Reinforce it immediately even if
      // an earlier worker still owns the processing lease, but keep the
      // delivery retryable until one exact lease records completion.
      if (upperMessage === "STOP") {
        await pauseLegacyWorker("Paused by verified owner via signed SMS retry");
      }
      res.status(503).send("<Response></Response>");
      return;
    }
    const completeAndRespond = async () => {
      const completed = await completeInboundSms(messageSid, lease.token);
      if (!completed) {
        throw new Error(
          "Inbound SMS processing lease was lost before completion"
        );
      }
      res.status(200).send("<Response></Response>");
    };

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
      await logExecution({
        actionType: "kill_switch_activated",
        details: { triggeredBy: "verified_owner", method: "signed_sms" },
        outcome: "success",
      });
      await completeAndRespond();
      await sendSMS(
        from,
        "[Addison] Got it — system paused. Text START when you want me back on."
      ).catch(() => {});
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
        await completeAndRespond();
        return;
      }
      await sendSMS(from, "[Addison] Back online! I'll pick up where I left off.");
      await logExecution({
        actionType: "kill_switch_deactivated",
        details: { triggeredBy: "verified_owner", method: "signed_sms" },
        outcome: "success",
      });
      await completeAndRespond();
      return;
    }

    // APPROVE <id>
    if (upperMessage === "APPROVE" || upperMessage.startsWith("APPROVE ")) {
      const match =
        /^APPROVE\s+#?(\d+)(?:\s+([A-F0-9]{64})\s+([A-F0-9-]{36}))?$/.exec(
          upperMessage
        );
      if (!match) {
        await sendSMS(from, "[Addison] Which task? E.g. APPROVE 123");
        await completeAndRespond();
        return;
      }
      const gate = await getLegacyWorkerRuntimeGate();
      if (!gate.allowed) {
        await sendSMS(from, `[Addison] Can't approve right now: ${gate.reason}.`);
        await completeAndRespond();
        return;
      }
      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        const externalTask = new Set([
          "outbound_call",
          "send_email",
          "send_sms",
        ]).has(task.actionType || "");
        const approvalFingerprint = match[2]?.toLowerCase();
        const approvalRequestId = match[3]?.toLowerCase();
        if (
          externalTask &&
          (!approvalFingerprint ||
            !approvalRequestId ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              approvalRequestId
            ))
        ) {
          await sendSMS(
            from,
            `[Addison] Task #${task.id} needs the exact approval token and request ID shown with its final content. Use the complete APPROVE command or review it in the private dashboard.`
          );
          await completeAndRespond();
          return;
        }
        const approval = await updateTaskByOwnerWithAudit(task.id, {
          status: "pending",
          expectedStatus: "awaiting_approval",
          ...(approvalFingerprint ? { approvalFingerprint } : {}),
          ...(approvalRequestId ? { approvalRequestId } : {}),
          approvalSource: "verified_sms",
        });
        if (
          approval.outcome === "approval_stale" ||
          approval.outcome === "state_conflict"
        ) {
          await sendSMS(
            from,
            `[Addison] Task #${task.id} changed after approval was requested. It remains paused; review the current task and request approval again.`
          );
          await completeAndRespond();
          return;
        }
        await sendSMS(from, `[Addison] Task #${task.id} approved — on it: "${task.description.substring(0, 80)}"`);
      } else {
        await sendSMS(from, `[Addison] Task #${match[1]} isn't waiting for approval.`);
      }
      await completeAndRespond();
      return;
    }

    // REJECT <id>
    if (upperMessage === "REJECT" || upperMessage.startsWith("REJECT ")) {
      const match = /^REJECT\s+#?(\d+)$/.exec(upperMessage);
      if (!match) {
        await sendSMS(from, "[Addison] Which task? E.g. REJECT 123");
        await completeAndRespond();
        return;
      }
      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        const rejection = await updateTaskByOwnerWithAudit(task.id, {
          status: "cancelled",
          expectedStatus: "awaiting_approval",
        });
        if (
          rejection.outcome === "state_conflict" ||
          rejection.outcome === "approval_stale"
        ) {
          await sendSMS(
            from,
            `[Addison] Task #${task.id} changed before rejection. Refresh its current status before trying again.`
          );
        } else {
          await sendSMS(from, `[Addison] Task #${task.id} cancelled.`);
        }
      } else {
        await sendSMS(from, `[Addison] Task #${match[1]} isn't waiting for approval.`);
      }
      await completeAndRespond();
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
      await completeAndRespond();
      return;
    }

    // ── Natural language — route to Addison's conversational handler ──────────
    // Handles: TASKS, DONE, HELP, and any free-text instruction
    const conversationalGate = await getLegacyWorkerRuntimeGate();
    if (!conversationalGate.allowed) {
      await completeAndRespond();
      return;
    }
    await handleConversationalSMS(message, from, `twilio:${messageSid}`);
    await completeAndRespond();

  } catch (error: any) {
    console.error(
      "[SMS Webhook] Handler failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(500).send("<Response></Response>");
  }
}
