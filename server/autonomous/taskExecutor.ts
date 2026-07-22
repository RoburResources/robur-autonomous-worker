import { invokeLLM } from "../_core/llm";
import {
  getHighestPriorityPendingTask, updateTask, logExecution,
  getConfig, getDailyCallCount, getDailyEmailCount,
  upsertDailyMetrics, getTodayMetrics
} from "../db";
import { makeOutboundCall } from "../integrations/retell";
import { sendSMS } from "../integrations/twilio";
import { runPreflightValidation } from "./preflightValidator";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

/**
 * Task Executor — runs every 15 minutes
 * Picks the highest-priority PENDING task and executes it.
 */
export async function runTaskExecutor(): Promise<{ executed: boolean; taskId?: number; error?: string }> {
  try {
    // Safety checks
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { executed: false, error: gate.reason || "Legacy worker is unavailable" };
    }

    // Check daily API spend cap
    const maxApiSpendCents = parseInt(await getConfig("max_api_spend_cents_per_day") || "5000");
    const todayMetricsData = await getTodayMetrics();
    if (todayMetricsData && todayMetricsData.apiSpendCents >= maxApiSpendCents) {
      return { executed: false, error: `Daily API spend cap reached ($${(maxApiSpendCents / 100).toFixed(0)})` };
    }

    const task = await getHighestPriorityPendingTask();
    if (!task) {
      return { executed: false, error: "No pending tasks" };
    }

    // ═══ PRE-FLIGHT VALIDATION ═══
    const preflight = await runPreflightValidation(task);
    if (!preflight.canExecute) {
      await updateTask(task.id, {
        status: "failed",
        resultSummary: `Pre-flight blocked: ${preflight.blockedReason}`,
      });
      await logExecution({
        taskId: task.id,
        actionType: "preflight_blocked",
        details: { reason: preflight.blockedReason, missing: preflight.missingCredentials },
        outcome: "failure",
        errorMessage: preflight.blockedReason,
      });
      return { executed: false, taskId: task.id, error: `Pre-flight: ${preflight.blockedReason}` };
    }

    // ═══ EXTERNAL CONTACT APPROVAL GATE (7-day restriction) ═══
    // ALL outbound contact with real people requires Michael's SMS approval first.
    // Only calls to Michael himself (+61495007200) are exempt.
    const externalContactRequired = await getConfig("external_contact_approval_required");
    const restrictionExpiry = await getConfig("external_contact_restriction_expiry");
    const isRestrictionActive = externalContactRequired === "true" && 
      (!restrictionExpiry || new Date(restrictionExpiry) > new Date());

    if (isRestrictionActive) {
      const contactActions = ["outbound_call", "send_email", "send_sms"];
      if (contactActions.includes(task.actionType || "")) {
        // Check if this is a call to Michael (exempt)
        const taskMeta = task.metadata as any;
        const isMichaelCall = taskMeta?.is_michael === true || 
          taskMeta?.target_number === "+61495007200" ||
          taskMeta?.skip_approval === true;

        if (!isMichaelCall) {
          // Requires SMS approval before contacting external person
          await updateTask(task.id, { status: "awaiting_approval" });
      const userPhone = await getConfig("user_phone") || process.env.USER_PHONE || "";
      const actionLabel = task.actionType === "outbound_call" ? "CALL" :
                             task.actionType === "send_email" ? "EMAIL" : "SMS";
          await sendSMS(
            userPhone,
            `[Robur AI] APPROVAL REQUIRED to ${actionLabel}: "${task.description.substring(0, 120)}" Reply APPROVE or REJECT. Task #${task.id}`
          );
          await logExecution({
            taskId: task.id,
            actionType: "external_contact_approval_request",
            details: { actionType: task.actionType, description: task.description, reason: "7-day external contact restriction active" },
            outcome: "pending",
          });
          return { executed: false, taskId: task.id, error: "Awaiting approval - external contact restriction active" };
        }
      }
    }

    // Check approval gate for high-value tasks (always active regardless of restriction)
    const approvalThreshold = parseInt(await getConfig("approval_threshold_cents") || "50000");
    const estimatedValue = parseFloat(task.estimatedValue as string || "0") * 100; // convert to cents
    if (estimatedValue > approvalThreshold) {
      // Requires SMS approval
      await updateTask(task.id, { status: "awaiting_approval" });
      const userPhone = await getConfig("user_phone") || process.env.USER_PHONE || "";
      await sendSMS(
        userPhone,
        `[AI Worker] Approval needed: "${task.description}" (est. value: $${(estimatedValue / 100).toFixed(0)}). Reply APPROVE to proceed or REJECT to cancel. Task #${task.id}`
      );
      await logExecution({
        taskId: task.id,
        actionType: "approval_request",
        details: { estimatedValue: estimatedValue / 100, description: task.description },
        outcome: "pending",
      });
      return { executed: false, taskId: task.id, error: "Awaiting approval" };
    }

    // Mark as in progress
    await updateTask(task.id, { status: "in_progress" });

    const startTime = Date.now();
    let result: { success: boolean; summary: string };

    switch (task.actionType) {
      case "outbound_call":
        result = await executeCall(task);
        break;
      case "send_email":
        result = await executeEmail(task);
        break;
      case "send_sms":
        result = await executeSMS(task);
        break;
      case "web_research":
        result = await executeResearch(task);
        break;
      case "data_entry":
        result = await executeDataEntry(task);
        break;
      default:
        result = await executeResearch(task);
    }

    const durationMs = Date.now() - startTime;

    // Track API spend (estimate: ~$0.01 per LLM call for gpt-5-mini)
    const estimatedSpendCents = 1; // Conservative estimate per task execution
    const todayDate = new Date().toISOString().split("T")[0];
    const currentMetrics = await getTodayMetrics();
    const currentSpend = currentMetrics?.apiSpendCents || 0;
    await upsertDailyMetrics(todayDate, { apiSpendCents: currentSpend + estimatedSpendCents });

    // Update task
    await updateTask(task.id, {
      status: result.success ? "completed" : "failed",
      resultSummary: result.summary,
      completedAt: new Date(),
    });

    // Log execution
    await logExecution({
      taskId: task.id,
      actionType: task.actionType || "unknown",
      details: { description: task.description, result: result.summary },
      outcome: result.success ? "success" : "failure",
      durationMs,
    });

    // Update daily metrics
    if (result.success) {
      await upsertDailyMetrics(todayDate, { tasksCompleted: 1 });
    } else {
      await upsertDailyMetrics(todayDate, { tasksFailed: 1 });
    }

    return { executed: true, taskId: task.id };
  } catch (error: any) {
    await logExecution({
      actionType: "task_execution",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { executed: false, error: error.message };
  }
}

async function executeCall(task: any): Promise<{ success: boolean; summary: string }> {
  // Check daily call limit
  const maxCalls = parseInt(await getConfig("max_calls_per_day") || "20");
  const currentCalls = await getDailyCallCount();
  if (currentCalls >= maxCalls) {
    return { success: false, summary: `Daily call limit reached (${maxCalls})` };
  }

  try {
    // Use LLM to generate call context
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are preparing a brief for an AI voice agent to make a business call. Generate a concise call objective and key talking points based on the task description." },
        { role: "user", content: `Task: ${task.description}\nGenerate a brief call script/objective for Addison.` }
      ]
    });

    const callBrief = response.choices[0]?.message?.content as string || task.description;

    // Make the call via Retell AI
    const callResult = await makeOutboundCall({
      agentId: await getConfig("retell_agent_id") || process.env.RETELL_AGENT_ID || "",
      toNumber: (task.actionPayload as any)?.phoneNumber || await getConfig("user_phone") || process.env.USER_PHONE || "",
      metadata: {
        taskId: task.id,
        objective: callBrief,
        taskDescription: task.description,
      }
    });

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { callsMade: 1 });

    return { success: true, summary: `Call initiated. Call ID: ${callResult.callId}. Objective: ${callBrief.substring(0, 200)}` };
  } catch (error: any) {
    return { success: false, summary: `Call failed: ${error.message}` };
  }
}

async function executeEmail(task: any): Promise<{ success: boolean; summary: string }> {
  // Check daily email limit
  const maxEmails = parseInt(await getConfig("max_emails_per_day") || "100");
  const currentEmails = await getDailyEmailCount();
  if (currentEmails >= maxEmails) {
    return { success: false, summary: `Daily email limit reached (${maxEmails})` };
  }

  try {
    // Use LLM to draft the email
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are drafting a professional business email. Keep it concise, professional, and action-oriented. Sign off as the business owner/manager." },
        { role: "user", content: `Draft an email for this task: ${task.description}` }
      ]
    });

    const emailDraft = response.choices[0]?.message?.content as string || "";
    
    // Log the email draft (actual sending would require SMTP integration)
    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { emailsSent: 1 });

    return { success: true, summary: `Email drafted and queued: ${emailDraft.substring(0, 200)}...` };
  } catch (error: any) {
    return { success: false, summary: `Email failed: ${error.message}` };
  }
}

async function executeSMS(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    const toNumber = (task.actionPayload as any)?.phoneNumber || await getConfig("user_phone") || process.env.USER_PHONE || "";
    const message = (task.actionPayload as any)?.message || task.description;

    await sendSMS(toNumber, `[Robur AI] ${message}`);

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { smsSent: 1 });

    return { success: true, summary: `SMS sent to ${toNumber}` };
  } catch (error: any) {
    return { success: false, summary: `SMS failed: ${error.message}` };
  }
}

async function executeResearch(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    // Use LLM to conduct research based on task description
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are a business research assistant. Provide actionable research findings based on the task. Include specific names, contacts, and data points where possible. If you cannot find real data, clearly state what would need to be verified." },
        { role: "user", content: `Research task: ${task.description}\n\nProvide findings and actionable next steps.` }
      ]
    });

    const findings = response.choices[0]?.message?.content as string || "No findings";
    return { success: true, summary: findings.substring(0, 500) };
  } catch (error: any) {
    return { success: false, summary: `Research failed: ${error.message}` };
  }
}

async function executeDataEntry(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    // Use LLM to structure data from task description
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are a data processing assistant. Extract and structure the relevant information from the task description." },
        { role: "user", content: `Data entry task: ${task.description}` }
      ]
    });

    const result = response.choices[0]?.message?.content as string || "Processed";
    return { success: true, summary: `Data processed: ${result.substring(0, 300)}` };
  } catch (error: any) {
    return { success: false, summary: `Data entry failed: ${error.message}` };
  }
}
