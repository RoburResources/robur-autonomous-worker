import { Request, Response } from "express";
import { parseInboundSMS } from "../integrations/twilio";
import { setConfig, getConfig, updateTask, logExecution, getTasksByStatus } from "../db";
import { sendSMS } from "../integrations/twilio";

/**
 * SMS Webhook Handler
 * Receives inbound SMS from Twilio
 * Handles: STOP kill switch, APPROVE/REJECT for pending approvals
 * 
 * POST /api/webhooks/sms
 */
export async function smsWebhookHandler(req: Request, res: Response) {
  try {
    const { from, message, messageSid } = parseInboundSMS(req.body);

    if (!message) {
      res.status(200).send("<Response></Response>");
      return;
    }

    const upperMessage = message.toUpperCase().trim();

    await logExecution({
      actionType: "inbound_sms",
      details: { from, message, messageSid },
      outcome: "success",
    });

    // STOP kill switch
    if (upperMessage === "STOP") {
      await setConfig("kill_switch_active", "true", "Kill switch activated via SMS");
      await setConfig("system_status", "paused", "Paused by STOP command");

      await sendSMS(from, "[Robur AI] All autonomous operations STOPPED. Send START to resume.");

      await logExecution({
        actionType: "kill_switch_activated",
        details: { triggeredBy: from, method: "sms" },
        outcome: "success",
      });

      res.status(200).send("<Response></Response>");
      return;
    }

    // START to resume
    if (upperMessage === "START") {
      await setConfig("kill_switch_active", "false");
      await setConfig("system_status", "active");

      await sendSMS(from, "[Robur AI] Autonomous operations RESUMED. System is active.");

      await logExecution({
        actionType: "kill_switch_deactivated",
        details: { triggeredBy: from, method: "sms" },
        outcome: "success",
      });

      res.status(200).send("<Response></Response>");
      return;
    }

    // APPROVE — approve the most recent pending approval task
    if (upperMessage === "APPROVE" || upperMessage.startsWith("APPROVE")) {
      const awaitingTasks = await getTasksByStatus("awaiting_approval", 1);
      if (awaitingTasks.length > 0) {
        const task = awaitingTasks[0];
        await updateTask(task.id, { status: "pending" }); // Move back to pending for execution
        await sendSMS(from, `[Robur AI] Task #${task.id} APPROVED: "${task.description.substring(0, 80)}". Will execute shortly.`);

        await logExecution({
          taskId: task.id,
          actionType: "approval_granted",
          details: { approvedBy: from },
          outcome: "success",
        });
      } else {
        await sendSMS(from, "[Robur AI] No tasks awaiting approval.");
      }

      res.status(200).send("<Response></Response>");
      return;
    }

    // REJECT — reject the most recent pending approval task
    if (upperMessage === "REJECT" || upperMessage.startsWith("REJECT")) {
      const awaitingTasks = await getTasksByStatus("awaiting_approval", 1);
      if (awaitingTasks.length > 0) {
        const task = awaitingTasks[0];
        await updateTask(task.id, { status: "cancelled", resultSummary: "Rejected by user via SMS" });
        await sendSMS(from, `[Robur AI] Task #${task.id} REJECTED and cancelled.`);

        await logExecution({
          taskId: task.id,
          actionType: "approval_rejected",
          details: { rejectedBy: from },
          outcome: "success",
        });
      } else {
        await sendSMS(from, "[Robur AI] No tasks awaiting approval.");
      }

      res.status(200).send("<Response></Response>");
      return;
    }

    // STATUS — get system status
    if (upperMessage === "STATUS") {
      const status = await getConfig("system_status") || "unknown";
      const killSwitch = await getConfig("kill_switch_active") || "false";
      await sendSMS(from, `[Robur AI] Status: ${status} | Kill switch: ${killSwitch === "true" ? "ACTIVE" : "off"}`);
      res.status(200).send("<Response></Response>");
      return;
    }

    // Unknown command
    await sendSMS(from, "[Robur AI] Commands: STOP (pause all), START (resume), APPROVE, REJECT, STATUS");
    res.status(200).send("<Response></Response>");
  } catch (error: any) {
    console.error("[SMS Webhook] Error:", error);
    res.status(200).send("<Response></Response>"); // Always 200 for Twilio
  }
}
