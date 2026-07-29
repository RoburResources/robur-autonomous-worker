import { invokeLLM } from "../_core/llm";
import { randomUUID } from "node:crypto";
import {
  getDagReadyTask, checkDagReadiness, unlockDependents
} from "./dagEngine";
import {
  getConfig, setConfig, isKillSwitchActive, getDailyCallCount, getDailyEmailCount,
  upsertDailyMetrics, getTodayMetrics, updateTask, logExecution, getTaskById,
  claimPendingTask, requeueStaleInProgressTasks, updateClaimedTask
} from "../db";
import { makeOutboundCall } from "../integrations/retell";
import { sendSMS } from "../integrations/twilio";
import { runPreflightValidation } from "./preflightValidator";
import { runPremortem } from "./premortem";
import { verifyTaskOutcome } from "./verifier";
import { validateTaskInput, validateTaskOutput } from "./schemaValidator";
import { runCanaryExecution } from "./canaryExecution";
import { getTaskContext, storeTaskOutcome, storeContactInteraction } from "../memory/mem0";
import { sendEmail, parseEmailDraft, buildEmailTemplate, isSendGridConfigured } from "../integrations/sendgrid";
import { getActiveExperiment, assignVariant, recordVariantOutcome } from "./abTesting";
import {
  isPrivateCandidateInternalAction,
  isPrivateCandidateInternalOnly,
} from "../safety/privateCandidatePolicy";
import {
  formatGroundedResearchSummary,
  runGroundedWebResearch,
} from "../_core/webResearch";
import { normalizeTaskMetadata } from "./taskMetadata";

type ActionExecutionResult = {
  success: boolean;
  summary: string;
  metadata?: Record<string, unknown>;
};

const EXECUTION_LEASE_TIMEOUT_MS = 30 * 60 * 1_000;

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
export async function runTaskExecutor(
  requestedTaskId?: number
): Promise<{
  executed: boolean;
  taskId?: number;
  succeeded?: boolean;
  error?: string;
}> {
  let currentTaskId: number | undefined;
  let taskClaimed = false;
  let taskClaimToken: string | undefined;
  try {
    // ── 1. Kill switch + API spend ────────────────────────────────────────────
    if (await isKillSwitchActive()) {
      return { executed: false, error: "Kill switch is active" };
    }

    const recoveredTaskIds = await requeueStaleInProgressTasks(
      new Date(Date.now() - EXECUTION_LEASE_TIMEOUT_MS)
    );
    for (const recoveredTaskId of recoveredTaskIds) {
      await logExecution({
        taskId: recoveredTaskId,
        actionType: "task_execution_stale_claim_recovered",
        details: {
          leaseTimeoutMinutes: EXECUTION_LEASE_TIMEOUT_MS / 60_000,
        },
        outcome: "partial",
        errorMessage:
          "Interrupted execution lease expired; task returned to pending",
      });
    }

    const maxApiSpendCents = parseInt(await getConfig("max_api_spend_cents_per_day") || "5000");
    const todayMetricsData = await getTodayMetrics();
    if (todayMetricsData && todayMetricsData.apiSpendCents >= maxApiSpendCents) {
      return { executed: false, error: `Daily API spend cap reached ($${(maxApiSpendCents / 100).toFixed(0)})` };
    }

    // ── 2. DAG-aware task selection ───────────────────────────────────────────
    const selectedTask = requestedTaskId
      ? await getTaskById(requestedTaskId)
      : await getDagReadyTask();
    if (!selectedTask) {
      return {
        executed: false,
        error: requestedTaskId
          ? "Requested task was not found"
          : "No DAG-ready pending tasks",
      };
    }
    const task = {
      ...selectedTask,
      metadata: normalizeTaskMetadata(selectedTask.metadata),
    };
    if (task.status !== "pending") {
      return {
        executed: false,
        taskId: task.id,
        error: `Requested task is ${task.status}, not pending`,
      };
    }
    if (requestedTaskId) {
      const readiness = await checkDagReadiness(task);
      if (!readiness.isReady) {
        return {
          executed: false,
          taskId: task.id,
          error: `Requested task is blocked by dependencies: ${readiness.blockedBy.join(", ")}`,
        };
      }
    }
    currentTaskId = task.id;

    if (
      isPrivateCandidateInternalOnly() &&
      !isPrivateCandidateInternalAction(task.actionType)
    ) {
      await updateTask(task.id, {
        status: "awaiting_approval",
        resultSummary:
          "Blocked by private-candidate internal-only containment policy",
      });
      await logExecution({
        taskId: task.id,
        actionType: "private_candidate_external_action_blocked",
        details: {
          requestedActionType: task.actionType,
          containment: "internal-only",
        },
        outcome: "pending",
        errorMessage:
          "External action blocked by private-candidate containment policy",
      });
      return {
        executed: false,
        taskId: task.id,
        error: "External action blocked by private-candidate policy",
      };
    }

    // A private candidate has no designated persistent data target. Treating
    // generic prose as a completed data update causes false-success claims;
    // hold these legacy tasks until an explicit private target is supplied.
    if (isPrivateCandidateInternalOnly() && task.actionType === "data_entry") {
      await updateTask(task.id, {
        status: "awaiting_approval",
        resultSummary:
          "Private candidate requires an explicit private data target before data-entry execution",
      });
      await logExecution({
        taskId: task.id,
        actionType: "private_candidate_data_target_required",
        details: { containment: "internal-only" },
        outcome: "pending",
        errorMessage: "No explicit private data target",
      });
      return {
        executed: false,
        taskId: task.id,
        error: "Private candidate data target required",
      };
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
      // Unmet dependencies: leave task PENDING so it retries when deps resolve
      // Missing credentials: leave PENDING so it retries when creds are added
      // Only hard failures (invalid input, config errors) should mark as failed
      const isRetryable = preflight.blockedReason?.includes("Unmet dependencies") ||
        preflight.blockedReason?.includes("Task blocked:") ||
        preflight.missingCredentials && preflight.missingCredentials.length > 0;
      if (isRetryable) {
        // Keep as pending — will be skipped by DAG engine and retried next cycle
        await logExecution({
          taskId: task.id,
          actionType: "preflight_blocked",
          details: { reason: preflight.blockedReason, missing: preflight.missingCredentials, retryable: true },
          outcome: "pending",
          errorMessage: preflight.blockedReason,
        });
        return { executed: false, taskId: task.id, error: `Pre-flight (retryable): ${preflight.blockedReason}` };
      }
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
    // Auto-clear expired restriction
    const restrictionExpired = restrictionExpiry && new Date(restrictionExpiry) <= new Date();
    if (externalContactRequired === "true" && restrictionExpired) {
      await setConfig("external_contact_approval_required", "false", "Auto-cleared: restriction expiry date passed");
      console.log("[Executor] External contact restriction auto-cleared (expired)");
    }
    const isRestrictionActive = externalContactRequired === "true" && !restrictionExpired &&
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

    // High-value approval gate — only applies to external contact actions
    // Internal tasks (web_research, data_entry) are never gated regardless of estimated value
    // estimated_value represents revenue potential, not action cost
    const externalContactActions = ["outbound_call", "send_email", "send_sms"];
    const isExternalContactTask = externalContactActions.includes(task.actionType || "");
    const approvalThreshold = parseInt(await getConfig("approval_threshold_cents") || "50000");
    const estimatedValue = parseFloat(task.estimatedValue as string || "0") * 100;
    if (isExternalContactTask && estimatedValue > approvalThreshold) {
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
    let premortem;
    try {
      premortem = await runPremortem(task);
    } catch (error: any) {
      if (error.message?.includes("LLM_USAGE_EXHAUSTED") || error.message?.includes("usage exhausted")) {
        // LLM unavailable — use heuristic confidence based on task type and priority
        console.warn("[TaskExecutor] LLM unavailable for pre-mortem, using heuristic confidence");
        const baseConfidence = {
          web_research: 0.92,
          data_entry: 0.90,
          send_email: 0.85,
          send_sms: 0.88,
          outbound_call: 0.80,
        }[task.actionType || "web_research"] || 0.85;
        premortem = {
          confidenceScore: baseConfidence,
          shouldEscalate: false,
          failureModes: ["LLM unavailable — using heuristic confidence"],
          escalationReason: null,
        };
      } else {
        throw error;
      }
    }

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
      if (!isPrivateCandidateInternalOnly()) {
        const userPhone = await getConfig("user_phone") || "+61495007200";
        await sendSMS(
          userPhone,
          `[Robur AI] LOW CONFIDENCE (${(premortem.confidenceScore * 100).toFixed(0)}%): "${task.description.substring(0, 100)}"\nReason: ${premortem.escalationReason}\nReply APPROVE to proceed or REJECT to cancel. Task #${task.id}`
        );
      }
      await logExecution({
        taskId: task.id,
        actionType: "confidence_gate_escalation",
        details: {
          confidenceScore: premortem.confidenceScore,
          escalationReason: premortem.escalationReason,
          failureModes: premortem.failureModes,
          notificationSent: !isPrivateCandidateInternalOnly(),
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
    const executionToken = randomUUID();
    if (!(await claimPendingTask(task.id, executionToken))) {
      await logExecution({
        taskId: task.id,
        actionType: "task_execution_claim_lost",
        details: {
          reason: "Task was no longer pending at the atomic execution claim",
        },
        outcome: "partial",
        errorMessage: "Another execution already claimed this task",
      });
      return {
        executed: false,
        taskId: task.id,
        error: "Task was already claimed by another execution",
      };
    }
    taskClaimed = true;
    taskClaimToken = executionToken;
    const startTime = Date.now();
    let result: ActionExecutionResult;

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

      // Research must be positively verified; other legacy action types keep
      // their existing fail-verdict behaviour.
      if (
        !verificationResult.verified &&
        (
          task.actionType === "web_research" ||
          verificationResult.verdict === "fail"
        )
      ) {
        result.success = false;
        result.summary = `${task.actionType === "web_research" ? "Research verification did not pass" : "Verification failed"} (score: ${(verificationResult.score * 100).toFixed(0)}%): ${verificationResult.reasoning}. Original: ${result.summary}`;
      }
    }

    // Finalise only if this execution still owns the current fencing token.
    // A recovery/retry invalidates the old token, so a stale worker cannot
    // overwrite the newer execution's result.
    const finalMeta = (task.metadata as Record<string, unknown>) || {};
    const finalised = await updateClaimedTask(task.id, executionToken, {
      status: result.success ? "completed" : "failed",
      resultSummary: result.summary,
      completedAt: new Date(),
      metadata: {
        ...finalMeta,
        premortem_confidence: premortem.confidenceScore,
        premortem_failure_modes: premortem.failureModes,
        premortem_ran_at: new Date().toISOString(),
        ...(result.metadata || {}),
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
    if (!finalised) {
      await logExecution({
        taskId: task.id,
        actionType: "task_execution_stale_result_discarded",
        details: {
          reason:
            "Execution fencing token no longer matched the current task claim",
        },
        outcome: "partial",
        errorMessage:
          "Stale execution result was discarded after lease recovery",
      });
      return {
        executed: false,
        taskId: task.id,
        error: "Execution claim expired; stale result discarded",
      };
    }
    taskClaimed = false;

    // Persist A/B outcomes only after schema validation, independent
    // verification, and fenced task finalisation. The task-derived key makes
    // retries update one record rather than creating duplicates.
    if (task.actionType === "web_research") {
      const experiment = result.metadata?.research_experiment as
        | { experiment_id?: unknown; variant_id?: unknown }
        | undefined;
      if (
        typeof experiment?.experiment_id === "string" &&
        typeof experiment.variant_id === "string"
      ) {
        await recordVariantOutcome({
          experimentId: experiment.experiment_id,
          variantId: experiment.variant_id,
          taskId: task.id,
          success: result.success,
          confidenceScore: verificationResult?.score || 0,
          metadata: {
            output_schema_valid: outputValidation.valid,
            verification_verified: verificationResult?.verified === true,
          },
        }).catch(() => {});
      }
    }

    // Grounded research includes a hosted web-search tool call. Keep the
    // accounting deliberately conservative so the daily cap fails closed.
    const estimatedSpendCents = task.actionType === "web_research" ? 10 : 2;
    const todayDate = new Date().toISOString().split("T")[0];
    const currentMetrics = await getTodayMetrics();
    const currentSpend = currentMetrics?.apiSpendCents || 0;
    await upsertDailyMetrics(todayDate, {
      apiSpendCents: currentSpend + estimatedSpendCents,
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

    // Store task outcome in Mem0 memory for future reference
    await storeTaskOutcome({
      taskId: task.id,
      description: task.description,
      actionType: task.actionType || "unknown",
      outcome: result.success ? "success" : "failure",
      resultSummary: result.summary.substring(0, 300),
      confidence: premortem.confidenceScore,
      executionTimeMs: durationMs,
    }).catch((e: any) => console.warn("[Mem0] storeTaskOutcome failed:", e.message));

    return {
      executed: true,
      taskId: task.id,
      succeeded: result.success,
      ...(result.success ? {} : { error: result.summary }),
    };
  } catch (error: any) {
    const isUsageExhausted = error.message?.includes("LLM_USAGE_EXHAUSTED") || error.message?.includes("usage exhausted");
    if (isUsageExhausted) {
      console.warn("[TaskExecutor] Skipping task — Manus Forge LLM quota exhausted. Will retry next cycle.");
      // Reset task to pending so it retries next cycle
      if (currentTaskId) {
        if (taskClaimed && taskClaimToken) {
          await updateClaimedTask(currentTaskId, taskClaimToken, {
            status: "pending",
          }).catch(() => false);
        } else {
          await updateTask(currentTaskId, { status: "pending" }).catch(() => {});
        }
      }
      return { executed: false, error: "LLM quota exhausted — task reset to pending" };
    }
    if (taskClaimed && currentTaskId && taskClaimToken) {
      await updateClaimedTask(currentTaskId, taskClaimToken, {
        status: "failed",
        resultSummary: `Task execution failed safely: ${error.message}`,
        completedAt: new Date(),
      }).catch(() => false);
    }
    await logExecution({
      taskId: currentTaskId,
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
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are preparing a brief for the Addison AI voice agent to make a business call for Robur Resources (scrap metal company in Perth). Generate a concise call objective and key talking points." },
        { role: "user", content: `Task: ${task.description}\nGenerate a brief call script/objective for Addison.` }
      ]
    });

    // A/B variant assignment for call scripts
    const callExperiment = await getActiveExperiment("outbound_call").catch(() => null);
    const callVariant = callExperiment ? assignVariant(callExperiment, task.id) : null;
    const callScript = callVariant?.content || null;

    const rawCallBrief = response.choices[0]?.message?.content;
    const callBrief = typeof rawCallBrief === 'string' ? rawCallBrief : task.description;
    const finalCallBrief = callScript ? `${callScript}\n\nContext: ${callBrief}` : callBrief;

    const callResult = await makeOutboundCall({
      agentId: await getConfig("retell_agent_id") || "agent_7f02eb1896dd1e6deb38e54942",
      toNumber: (task.actionPayload as any)?.phoneNumber || await getConfig("user_phone") || "+61495007200",
      metadata: { taskId: task.id, objective: callBrief, taskDescription: task.description }
    });

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { callsMade: 1 });

    // Track A/B variant outcome
    if (callExperiment && callVariant) {
      await recordVariantOutcome({
        experimentId: callExperiment.id,
        variantId: callVariant.id,
        taskId: task.id,
        success: true,
        confidenceScore: 0.8,
      }).catch(() => {});
    }

    // Store contact interaction in Mem0
    const toNumber = (task.actionPayload as any)?.phoneNumber;
    if (toNumber && toNumber !== await getConfig("user_phone")) {
      await storeContactInteraction({
        contactName: (task.metadata as any)?.contactName || toNumber,
        contactType: "supplier",
        channel: "phone",
        outcome: "connected",
        notes: finalCallBrief.substring(0, 200),
      }).catch(() => {});
    }

    return { success: true, summary: `Call initiated. Call ID: ${callResult.callId}. Objective: ${finalCallBrief.substring(0, 200)}` };
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
    // Get memory context for better email personalisation
    const memoryContext = await getTaskContext({
      taskDescription: task.description,
      actionType: "send_email",
      entityId: (task.metadata as any)?.entityId,
    }).catch(() => "");

    // Generate email content with LLM
    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are drafting a professional business email for Robur Resources, a resource recovery and sustainable solutions company in Perth, WA. Keep it concise, professional, and action-oriented. Include a Subject: line at the top. Sign off as 'Michael T, General Manager, Robur Resources'.${memoryContext}` },
        { role: "user", content: `Draft an email for this task: ${task.description}` }
      ]
    });

    const rawDraft = response.choices[0]?.message?.content;
    const emailDraft = typeof rawDraft === 'string' ? rawDraft : "";
    const { subject, body } = parseEmailDraft(emailDraft);

    // Get recipient from task metadata or action payload
    const taskMeta = (task.metadata as any) || {};
    const actionPayload = (task.actionPayload as any) || {};
    const recipientEmail = actionPayload.email || taskMeta.recipientEmail || "";
    const recipientName = actionPayload.name || taskMeta.recipientName;

    // A/B variant assignment for email subjects
    const emailExperiment = await getActiveExperiment("send_email").catch(() => null);
    const emailVariant = emailExperiment ? assignVariant(emailExperiment, task.id) : null;
    const abSubject = emailVariant?.content || subject;

    // Use template system for HTML emails
    const templateType = taskMeta.emailTemplate || "general_business";
    const { bodyHtml } = buildEmailTemplate(templateType as any, body, recipientName);

    let sendResult;
    if (recipientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      // Real recipient — send via SendGrid
      sendResult = await sendEmail({
        to: recipientEmail,
        toName: recipientName,
        subject: abSubject,
        bodyText: body,
        bodyHtml,
        templateType: templateType as any,
        metadata: { taskId: task.id, taskDescription: task.description },
      });
    } else {
      // No recipient — draft mode
      sendResult = {
        success: true,
        messageId: `draft_${Date.now()}`,
        deliveryStatus: "draft" as const,
        timestamp: new Date().toISOString(),
      };
    }

    const today = new Date().toISOString().split("T")[0];
    await upsertDailyMetrics(today, { emailsSent: 1 });

    // Track A/B variant outcome for email subject test
    if (emailExperiment && emailVariant) {
      await recordVariantOutcome({
        experimentId: emailExperiment.id,
        variantId: emailVariant.id,
        taskId: task.id,
        success: sendResult.success,
        confidenceScore: sendResult.deliveryStatus === 'sent' ? 0.9 : 0.6,
      }).catch(() => {});
    }

    // Store contact interaction in Mem0
    if (recipientEmail) {
      await storeContactInteraction({
        contactName: recipientName || recipientEmail,
        contactType: "supplier",
        channel: "email",
        outcome: sendResult.deliveryStatus === 'sent' ? 'connected' : 'not_interested',
        notes: `Subject: ${abSubject}`,
      }).catch(() => {});
    }

    const modeLabel = sendResult.deliveryStatus === 'sent' ? 'SENT' :
      sendResult.deliveryStatus === 'draft' ? 'DRAFTED (no recipient configured)' : 'FAILED';
    const sgLabel = isSendGridConfigured() ? 'via SendGrid' : 'draft mode (no SendGrid key)';

    return {
      success: sendResult.success,
      summary: `recipient: ${recipientEmail || 'none'} | status: ${modeLabel} ${sgLabel} | messageId: ${sendResult.messageId || 'n/a'} | subject: ${abSubject} | body: ${body.substring(0, 200)}`
    };
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

    // Store contact interaction in Mem0 for non-owner SMS
    const userPhone = await getConfig("user_phone") || "+61495007200";
    if (toNumber !== userPhone) {
      await storeContactInteraction({
        contactName: (task.metadata as any)?.contactName || toNumber,
        contactType: "supplier",
        channel: "sms",
        outcome: "connected",
        notes: message.substring(0, 200),
      }).catch(() => {});
    }

    return { success: true, summary: `message: SMS sent to ${toNumber}: ${message.substring(0, 100)}` };
  } catch (error: any) {
    return { success: false, summary: `SMS failed: ${error.message}` };
  }
}

async function executeResearch(task: any): Promise<ActionExecutionResult> {
  try {
    // Web search receives only the owner-authored research task. Private Mem0
    // context must never be exported into a tool-enabled external request.
    const grounded = await runGroundedWebResearch(task.description);
    const findings = grounded.text;

    // Assign a deterministic A/B variant now, but persist its outcome only
    // after schema validation and independent verification in the caller.
    const researchExperiment = await getActiveExperiment("web_research").catch(() => null);
    let researchExperimentMetadata: Record<string, string> | undefined;
    if (researchExperiment) {
      const researchVariant = assignVariant(researchExperiment, task.id);
      researchExperimentMetadata = {
        experiment_id: researchExperiment.id,
        variant_id: researchVariant.id,
      };
    }
    return {
      success: true,
      summary: formatGroundedResearchSummary(grounded),
      metadata: {
        grounded_research: {
          model: grounded.model,
          response_id: grounded.responseId,
          web_search_call_count: grounded.webSearchCallCount,
          attempt_count: grounded.attemptCount,
          sources: grounded.sources,
          completed_at: new Date().toISOString(),
        },
        ...(researchExperimentMetadata
          ? { research_experiment: researchExperimentMetadata }
          : {}),
      },
    };
  } catch (error: any) {
    return { success: false, summary: `Research failed: ${error.message}` };
  }
}

async function executeDataEntry(task: any): Promise<{ success: boolean; summary: string }> {
  try {
    const response = await invokeLLM({
      model: "gpt-4o-mini",
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
