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

/**
 * SMS Webhook Handler
 * Receives inbound SMS from Twilio
 * Handles verified owner controls only. Twilio signature and exact owner
 * sender verification are mandatory before any state change or SMS reply.
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
      },
      outcome: "success",
    });

    // STOP kill switch
    if (upperMessage === "STOP") {
      await pauseLegacyWorker("Paused by verified owner via signed SMS");

      await sendSMS(from, "[Robur AI] Legacy autonomous worker PAUSED.");

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
        await sendSMS(from, `[Robur AI] Resume blocked: ${reason}.`);
        res.status(200).send("<Response></Response>");
        return;
      }

      await sendSMS(
        from,
        "[Robur AI] Legacy autonomous worker RESUMED by verified owner."
      );

      await logExecution({
        actionType: "kill_switch_deactivated",
        details: { triggeredBy: "verified_owner", method: "signed_sms" },
        outcome: "success",
      });

      res.status(200).send("<Response></Response>");
      return;
    }

    // APPROVE <id> — approvals must bind to one exact task.
    if (upperMessage === "APPROVE" || upperMessage.startsWith("APPROVE ")) {
      const match = /^APPROVE\s+#?(\d+)$/.exec(upperMessage);
      if (!match) {
        await sendSMS(
          from,
          "[Robur AI] Include the exact task ID, for example: APPROVE 123."
        );
        res.status(200).send("<Response></Response>");
        return;
      }

      const gate = await getLegacyWorkerRuntimeGate();
      if (!gate.allowed) {
        await sendSMS(from, `[Robur AI] Approval blocked: ${gate.reason}.`);
        res.status(200).send("<Response></Response>");
        return;
      }

      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        await updateTask(task.id, { status: "pending" }); // Move back to pending for execution
        await sendSMS(
          from,
          `[Robur AI] Task #${task.id} APPROVED: "${task.description.substring(0, 80)}". Will execute shortly.`
        );

        await logExecution({
          taskId: task.id,
          actionType: "approval_granted",
          details: { approvedBy: "verified_owner", taskId: task.id },
          outcome: "success",
        });
      } else {
        await sendSMS(
          from,
          `[Robur AI] Task #${match[1]} is not awaiting approval.`
        );
      }

      res.status(200).send("<Response></Response>");
      return;
    }

    // REJECT <id> — rejection remains available while paused.
    if (upperMessage === "REJECT" || upperMessage.startsWith("REJECT ")) {
      const match = /^REJECT\s+#?(\d+)$/.exec(upperMessage);
      if (!match) {
        await sendSMS(
          from,
          "[Robur AI] Include the exact task ID, for example: REJECT 123."
        );
        res.status(200).send("<Response></Response>");
        return;
      }

      const task = await getTaskById(Number(match[1]));
      if (task?.status === "awaiting_approval") {
        await updateTask(task.id, {
          status: "cancelled",
          resultSummary: "Rejected by user via SMS",
        });
        await sendSMS(
          from,
          `[Robur AI] Task #${task.id} REJECTED and cancelled.`
        );

        await logExecution({
          taskId: task.id,
          actionType: "approval_rejected",
          details: { rejectedBy: "verified_owner", taskId: task.id },
          outcome: "success",
        });
      } else {
        await sendSMS(
          from,
          `[Robur AI] Task #${match[1]} is not awaiting approval.`
        );
      }

      res.status(200).send("<Response></Response>");
      return;
    }

    // STATUS — get system status
    if (upperMessage === "STATUS") {
      const status = (await getConfig("system_status")) || "unknown";
      const gate = await getLegacyWorkerRuntimeGate();
      await sendSMS(
        from,
        `[Robur AI] Status: ${status} | Autonomous execution: ${gate.allowed ? "ENABLED" : "BLOCKED"}`
      );
      res.status(200).send("<Response></Response>");
      return;
    }

    // Unknown command
    await sendSMS(
      from,
      "[Robur AI] Commands: STOP, START, APPROVE <task ID>, REJECT <task ID>, STATUS"
    );
    res.status(200).send("<Response></Response>");
  } catch (error: any) {
    console.error(
      "[SMS Webhook] Verified request failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    res.status(500).send("<Response></Response>");
  }
}
