import { invokeLLM } from "../_core/llm";
import {
  getActiveGoals, getTasksByStatus, getRecentTasks, getRecentMetrics,
  getOpportunities, logExecution, getConfig
} from "../db";
import { makeBriefingCall } from "../integrations/retell";
import { getLegacyWorkerRuntimeGate } from "../safety/legacyWorkerGate";

/**
 * Morning Briefing — 8:00am AWST (00:00 UTC)
 * Addison calls user with: today's priorities, overnight opportunities, system status
 */
export async function runMorningBriefing(): Promise<{ success: boolean; error?: string }> {
  try {
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { success: false, error: gate.reason || "Legacy worker is unavailable" };
    }

    // Gather data for briefing
    const activeGoals = await getActiveGoals();
    const pendingTasks = await getTasksByStatus("pending", 10);
    const opportunities = await getOpportunities(5);
    const recentMetrics = await getRecentMetrics(7);

    // Generate briefing content with LLM
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `You are preparing a morning briefing for Michael T, General Manager of Robur Resources (scrap metal business, Perth WA). The briefing will be delivered by Addison, an AI voice assistant. Keep it concise (under 2 minutes when spoken), focused on priorities and actionable items. Use a warm, professional Australian tone.`
        },
        {
          role: "user",
          content: `Prepare a morning briefing with this data:

Active Goals (${activeGoals.length}):
${activeGoals.map(g => `- ${g.goalText} (priority: ${g.priority})`).join("\n")}

Today's Top Priority Tasks (${pendingTasks.length} pending):
${pendingTasks.slice(0, 5).map(t => `- [Score ${t.priorityScore}] ${t.description}`).join("\n")}

Recent Opportunities:
${opportunities.slice(0, 3).map(o => `- ${o.description} (${o.priority})`).join("\n") || "None detected"}

Recent Performance:
${recentMetrics.length > 0 ? `Last 7 days: ${recentMetrics.reduce((sum, m) => sum + m.tasksCompleted, 0)} tasks completed` : "No metrics yet"}

Generate a natural, conversational briefing script for Addison to deliver.`
        }
      ]
    });

    const briefingContent = response.choices[0]?.message?.content as string || "Good morning Michael. Your autonomous system is running. Check the dashboard for details.";

    // Make the call
    const callResult = await makeBriefingCall("morning", briefingContent);

    await logExecution({
      actionType: "morning_briefing",
      details: { callId: callResult.callId, briefingLength: briefingContent.length },
      outcome: "success",
    });

    return { success: true };
  } catch (error: any) {
    await logExecution({
      actionType: "morning_briefing",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { success: false, error: error.message };
  }
}

/**
 * Evening Briefing — 5:30pm AWST (09:30 UTC)
 * Addison calls user with: what was accomplished today, tomorrow's plan
 */
export async function runEveningBriefing(): Promise<{ success: boolean; error?: string }> {
  try {
    const gate = await getLegacyWorkerRuntimeGate();
    if (!gate.allowed) {
      return { success: false, error: gate.reason || "Legacy worker is unavailable" };
    }

    // Gather data for briefing
    const completedToday = await getTasksByStatus("completed", 20);
    const failedToday = await getTasksByStatus("failed", 10);
    const pendingTomorrow = await getTasksByStatus("pending", 10);
    const activeGoals = await getActiveGoals();

    // Generate briefing content
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `You are preparing an evening summary briefing for Michael T, General Manager of Robur Resources. The briefing will be delivered by Addison. Keep it concise (under 2 minutes spoken), summarize accomplishments, flag any issues, and preview tomorrow's priorities. Warm, professional Australian tone.`
        },
        {
          role: "user",
          content: `Prepare an evening briefing:

Completed Today (${completedToday.length} tasks):
${completedToday.slice(0, 8).map(t => `- ${t.description}: ${(t.resultSummary || "Done").substring(0, 100)}`).join("\n") || "No tasks completed yet"}

Issues/Failures (${failedToday.length}):
${failedToday.slice(0, 3).map(t => `- ${t.description}: ${(t.resultSummary || "Failed").substring(0, 80)}`).join("\n") || "None"}

Tomorrow's Top Priorities:
${pendingTomorrow.slice(0, 5).map(t => `- [Score ${t.priorityScore}] ${t.description}`).join("\n") || "Queue will be refreshed overnight"}

Generate a natural evening summary for Addison to deliver.`
        }
      ]
    });

    const briefingContent = response.choices[0]?.message?.content as string || "Good evening Michael. Here's your daily wrap-up. Check the dashboard for full details.";

    // Make the call
    const callResult = await makeBriefingCall("evening", briefingContent);

    await logExecution({
      actionType: "evening_briefing",
      details: { callId: callResult.callId, briefingLength: briefingContent.length },
      outcome: "success",
    });

    return { success: true };
  } catch (error: any) {
    await logExecution({
      actionType: "evening_briefing",
      details: { error: error.message },
      outcome: "failure",
      errorMessage: error.message,
    });
    return { success: false, error: error.message };
  }
}
