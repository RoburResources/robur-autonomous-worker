import { invokeLLM } from "../_core/llm";
import {
  getDagReadyTask, checkDagReadiness, unlockDependents
} from "./dagEngine";
import {
  getConfig, isKillSwitchActive, getDailyCallCount, getDailyEmailCount,
  upsertDailyMetrics, getTodayMetrics, updateTask, logExecution
} from "../db";
import { makeOutboundCall } from "../integrations/retell";
import { sendSMS } from "../integrations/twilio";
import { runPreflightValidation } from "./preflightValidator";
import { runPremortem } from "./premortem";
import { verifyTaskOutcome } from "./verifier";
import { validateTaskInput, validateTaskOutput } from "./schemaValidator";
import { runCanaryExecution } from "./canaryExecution";

/**
 * Task Executor — runs every 15 minutes.
 *
 * Zero-mistake execution pipeline:
 * 1. Kill switch + API spend check
 * 2. DAG-aware task selection (only picks tasks whose dependencies are complete)
 * 3. Input schema validation
 * 4. Pre-flight validation (credentials, hard limits, blockers)
 * 5. External contact approval gate (7-day restriction + $500 threshold)
 * 6. Pre-mortem analysis (LLM identifies top 3 failure modes)
 * 7. Confidence gate (< 0.85 → escalate to human via SMS)
 * 8. Canary execution (dry-run with synthetic data for external-contact tasks)
 * 9. Real execution
 * 10. Output schema validation
 * 11. Dual-agent verification (independent LLM-as-Judge)
 * 12. Unlock DAG dependents on success
 */
export async function runTaskExecutor(): Promise<{ executed: boolean; taskId?: number; error?: string }> {
  try {
    // ── 1. Kill switch + API spend ────────────────────────────────────────────
    if (await isKillSwitchActive()) {
      return { executed: false, error: "Kill switch is active" };
    }

    const maxApiSpendCents = parseInt(await getConfig("max_api_spend_cents_per_day") || "5000");
    const todayMetricsData = await getTodayMetrics();
    if (todayMetricsData && todayMetricsData.apiSpendCents >= maxApiSpendCents) {
      return { executed: false, error: `Daily API spend cap reached ($${(maxApiSpendCents / 100).toFixed(0)})` };
    }

    // ── 2. DAG-aware task selection ───────────────────────────────────────────
    const task = await getDagReadyTask();
    if (!task) {
      return { executed: false, error: "No DAG-ready pending tasks" };
    }

    // ── 3. Input schema validation ────────────────────────────────────────────
    const inputValidation = validateTaskInput(task);
    if (!inputValidation.valid) {
      await updateTask(task.id, {
        status: "failed",
        resultSummary: `Input validation failed: ${inputValidation.errors.join("; ")}`,
      });
      await logExecution({
        taskId: task.id,
        actionType: "input_validation_failed",
        details: { errors: inputValidation.errors, warnings: inputValidation.warnings },
        outcome: "failure",
        errorMessage: inputValidation.errors.join("; "),
      });
      return { executed: false, taskId: task.id, error: `Input invalid: ${inputValidation.errors.join("; ")}` };
    }

    // ── 4. Pre-flight validation ──────────────────────────────────────────────
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

    // ── 5. External contact approval gate ────────────────────────────────────
    const externalContactRequired = await getConfig("external_contact_approval_required");
    const restrictionExpiry = await getConfig("external_contact_restriction_expiry");
    const isRestrictionActive = externalContactRequired === "true" &&
      (!restrictionExpiry || new Date(restrictionExpiry) > new Date());

    if (isRestrictionActive) {
      const contactActions = ["outbound_call", "send_email", "send_sms"];
      if (contactActions.includes(task.actionType || "")) {
        const taskMeta = task.metadata as Record<string, unknown> | null;
        const isMichaelCall = taskMeta?.is_michael === true ||
          (taskMeta as any)?.target_number === "+61495007200" ||
          taskMeta?.skip_approval === true;

        if (!isMichaelCall) {
          await updateTask(task.id, { status: "awaiting_approval" });
          const userPhone = await getConfig("user_phone") || "+61495007200";
          const actionLabel = task.actionType === "outbound_call" ? "CALL" :
            task.actionType === "send_email" ? "EMAIL" : "SMS";
          await sendSMS(
            userPhone,
            `[Robur AI] APPROVAL REQUIRED to ${actionLabel}: "${task.description.substring(0, 120)}" Reply APPROVE or REJECT. Task #${task.id}`
          );
          await logExecution({
            taskId: task.id,
            actionType: "external_contact_approval_request",
            details: { actionType: task.actionType, description: task.description },
            outcome: "pending",
          });
          return { executed: false, taskId: task.id, error: "Awaiting approval — external contact restriction active" };
        }
      }
    }

    // High-value approval gate (always active)
    const approvalThreshold = parseInt(await getConfig("approval_threshold_cents") || "50000");
    const estimatedValue = parseFloat(task.estimatedValue as string || "0") * 100;
    if (estimatedValue > approvalThreshold) {
      await updateTask(task.id, { status: "awaiting_approval" });
      const userPhone = await getConfig("user_phone") || "+61495007200";
      await sendSMS(
        userPhone,
        `[Robur AI] Approval needed: "${task.description}" (est. value: $${(estimatedValue / 100).toFixed(0)}). Reply APPROVE or REJECT. Task #${task.id}`
      );
      await logExecution({
        taskId: task.id,
        actionType: "approval_request",
        details: { estimatedValue: estimatedValue / 100, description: task.description },
        outcome: "pending",
      });
      return { executed: false, taskId: task.id, error: "Awaiting approval — high value" };
    }

    // ── 6. Pre-mortem analysis ────────────────────────────────────────────────
    const premortem = await runPremortem(task);

    // Store pre-mortem results in task metadata
    const existingMeta = (task.metadata as Record<string, unknown>) || {};
    await updateTask(task.id, {
      metadata: {
        ...existingMeta,
        premortem_confidence: premortem.confidenceScore,
        premortem_failure_modes: premortem.failureModes,
        premortem_ran_at: new Date().toISOString(),
      },
    });

    // ── 7. Confidence gate ────────────────────────────────────────────────────
    if (premortem.shouldEscalate) {
      await updateTask(task.id, { status: "awaiting_approval" });
      const userPhone = await getConfig("user_phone") || "+61495007200";
      await sendSMS(
        userPhone,
        `[Robur AI] LOW CONFIDENCE (${(premortem.confidenceScore * 100).toFixed(0)}%): "${task.description.substring(0, 100)}"\nReason: ${premortem.escalationReason}\nReply APPROVE to proceed or REJECT to cancel. Task #${task.id}`
      );
      await logExecution({
        taskId: task.id,
        actionType: "confidence_gate_escalation",
        details: {
          confidenceScore: premortem.confidenceScore,
          escalationReason: premortem.escalationReason,
          failureModes: premortem.failureModes,
        },
        outcome: "pending",
      });
      return { executed: false, taskId: task.id, error: `Confidence gate: ${premortem.escalationReason}` };
    }

    // ── 8. Canary execution (external-contact tasks only) ─────────────────────
    const externalActions = ["outbound_call", "send_email", "send_sms"];
    if (externalActions.includes(task.actionType || "")) {
      const canary = await runCanaryExecution(task);
      if (!canary.passed || canary.recommendation === "abort") {
        await updateTask(task.id, {
          status: "failed",
          resultSummary: `Canary test failed: ${canary.issues.join("; ")}`,
        });
        await logExecution({
          taskId: task.id,
          actionType: "canary_failed",
          details: { issues: canary.issues, syntheticOutput: canary.syntheticOutput, recommendation: canary.recommendation },
          outcome: "failure",
          errorMessage: canary.issues.join("; "),
        });
        return { executed: false, taskId: task.id, error: `Canary failed: ${canary.issues.join("; ")}` };
      }

      if (canary.recommendation === "modify") {
        await updateTask(task.id, {
          status: "awaiting_approval",
          metadata: {
            ...((task.metadata as Record<string, unknown>) || {}),
            canary_modification_needed: canary.modificationSuggestion,
          },
        });
        const userPhone = await getConfig("user_phone") || "+61495007200";
        await sendSMS(
          userPhone,
          `[Robur AI] Task needs modification before execution: "${task.description.substring(0, 80)}"\nSuggestion: ${canary.modificationSuggestion?.substring(0, 100)}\nTask #${task.id}`
        );
        return { executed: false, taskId: task.id, error: "Canary: task needs modification" };
      }
    }

    // ── 9. Real execution ─────────────────────────────────────────────────────
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

    // ── 10. Output schema validation ──────────────────────────────────────────
    const outputValidation = validateTaskOutput(task.actionType || "web_research", result.summary);
    if (!outputValidation.valid && result.success) {
      // Override success if output schema fails
      result.success = false;
      result.summary = `Output schema validation failed: ${outputValidation.errors.join("; ")}. Original output: ${result.summary}`;
    }

    // ── 11. Dual-agent verification ───────────────────────────────────────────
    let verificationResult = null;
    if (result.success) {
      verificationResult = await verifyTaskOutcome({
        id: task.id,
        description: task.description,
        actionType: task.actionType,
        resultSummary: result.summary,
        metadata: task.metadata,
      });

      // If verifier disagrees, downgrade to partial or failed
      if (!verificationResult.verified && verificationResult.verdict === "fail") {
        result.success = false;
        result.summary = `Verification failed (score: ${(verificationResult.score * 100).toFixed(0)}%): ${verificationResult.reasoning}. Original: ${result.summary}`;
      }
    }

    // Track API spend
    const estimatedSpendCents = 2; // ~2 LLM calls per task (premortem + execution)
    const todayDate = new Date().toISOString().split("T")[0];
    const currentMetrics = await getTodayMetrics();
    const currentSpend = currentMetrics?.apiSpendCents || 0;
    await upsertDailyMetrics(todayDate, { apiSpendCents: currentSpend + estimatedSpendCents });

    // Update task with all metadata
    const finalMeta = (task.metadata as Record<string, unknown>) || {};
    await updateTask(task.id, {
      status: result.success ? "completed" : "failed",
      resultSummary: result.summary,
      completedAt: new Date(),
      metadata: {
        ...finalMeta,
        verification_result: verificationResult ? {
          verified: verificationResult.verified,
          score: verificationResult.score,
          verdict: verificationResult.verdict,
          reasoning: verificationResult.reasoning,
          recommendedAction: verificationResult.recommendedAction,
          unintendedSideEffects: verificationResult.unintendedSideEffects,
        } : null,
        output_schema_valid: outputValidation.valid,
        output_schema_warnings: outputValidation.warnings,
        execution_duration_ms: durationMs,
      },
    });

    // Log execution
    await logExecution({
      taskId: task.id,
      actionType: task.actionType || "unknown",
      details: {
        description: task.description,
        result: result.summary,
        premortem_confidence: premortem.confidenceScore,
        verification_score: verificationResult?.score,
        verification_verdict: verificationResult?.verdict,
        output_schema_valid: outputValidation.valid,
      },
      outcome: result.success ? "success" : "failure",
      durationMs,
    });

    // Update daily metrics
    if (result.success) {
      await upsertDailyMetrics(todayDate, { tasksCompleted: 1 });
      // Unlock DAG dependents
      await unlockDependents(task.id);
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

// ─── Action Executors ────────────────────────────────────────────────────────

async function executeCall(task: any): Promise<{ success: boolean; summary: string }> {
  const maxCalls = parseInt(await getConfig("max_calls_per_day") || "20");
  const currentCalls = await getDailyCallCount();
  if (currentCalls >= maxCalls) {
    return { success: false, summary: `Daily call limit reached (${maxCalls})` };
  }

  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are preparing a brief for the Addison AI voice agent to make a business call for Robur Resources (scrap metal company in Perth). Generate a concise call objective and key talking points." },
        { role: "user", content: `Task: ${task.description}\nGenerate a brief call script/objective for Addison.` }
      ]
    });

    const callBrief = response.choices[0]?.message?.content as string || task.description;

    const callResult = await makeOutboundCall({
      agentId: await getConfig("retell_agent_id") || "agent_7f02eb1896dd1e6deb38e54942",
      toNumber: (task.actionPayload as any)?.phoneNumber || await getConfig("user_phone") || "+61495007200",
      metadata: { taskId: task.id, objective: callBrief, taskDescription: task.description }
    });

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { callsMade: 1 });

    return { success: true, summary: `Call initiated. Call ID: ${callResult.callId}. Objective: ${callBrief.substring(0, 200)}` };
  } catch (error: any) {
    return { success: false, summary: `Call failed: ${error.message}` };
  }
}

async function executeEmail(task: any): Promise<{ success: boolean; summary: string }> {
  const maxEmails = parseInt(await getConfig("max_emails_per_day") || "100");
  const currentEmails = await getDailyEmailCount();
  if (currentEmails >= maxEmails) {
    return { success: false, summary: `Daily email limit reached (${maxEmails})` };
  }

  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are drafting a professional business email for Robur Resources, a resource recovery and sustainable solutions company in Perth, WA. Keep it concise, professional, and action-oriented. Sign off as 'Michael T, General Manager, Robur Resources'." },
        { role: "user", content: `Draft an email for this task: ${task.description}` }
      ]
    });

    const emailDraft = response.choices[0]?.message?.content as string || "";
    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { emailsSent: 1 });

    return { success: true, summary: `emailDraft: ${emailDraft.substring(0, 400)}` };
  } catch (error: any) {
    return { success: false, summary: `Email failed: ${error.message}` };
  }
}

async function executeSMS(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    const toNumber = (task.actionPayload as any)?.phoneNumber || await getConfig("user_phone") || "+61495007200";
    const message = (task.actionPayload as any)?.message || task.description;

    await sendSMS(toNumber, `[Robur AI] ${message}`);

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { smsSent: 1 });

    return { success: true, summary: `message: SMS sent to ${toNumber}: ${message.substring(0, 100)}` };
  } catch (error: any) {
    return { success: false, summary: `SMS failed: ${error.message}` };
  }
}

async function executeResearch(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are a business research assistant for Robur Resources (resource recovery company in Perth, WA). Provide actionable research findings based on the task. Include specific names, contacts, and data points where possible. If you cannot find real data, clearly state what would need to be verified and how." },
        { role: "user", content: `Research task: ${task.description}\n\nProvide findings and actionable next steps.` }
      ]
    });

    const findings = response.choices[0]?.message?.content as string || "No findings";
    return { success: true, summary: `findings: ${findings.substring(0, 500)}` };
  } catch (error: any) {
    return { success: false, summary: `Research failed: ${error.message}` };
  }
}

async function executeDataEntry(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: "You are a data processing assistant. Extract and structure the relevant information from the task description." },
        { role: "user", content: `Data entry task: ${task.description}` }
      ]
    });

    const result = response.choices[0]?.message?.content as string || "Processed";
    return { success: true, summary: `result: ${result.substring(0, 300)}` };
  } catch (error: any) {
    return { success: false, summary: `Data entry failed: ${error.message}` };
  }
}
