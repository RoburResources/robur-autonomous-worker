/**
 * Cross-Cycle Dependency Resolver — Part B of DAG resolution.
 * Resolves dependencies on tasks from previous cycles using semantic matching.
 * Runs when a task has dependency labels but no numeric IDs (cross-cycle references).
 */

import { invokeLLM } from "../_core/llm";

export interface SemanticMatch {
  taskId: number;
  taskDescription: string;
  matchScore: number; // 0–1, how well the task matches the label
  reasoning: string;
}

/**
 * Resolve a dependency label to a task ID by semantic matching against completed tasks.
 * Used for cross-cycle dependencies where the numeric ID is not known at generation time.
 */
export async function resolveDependencyLabel(
  label: string,
  recentCompletedTasks: Array<{ id: number; description: string }>
): Promise<{ taskId: number | null; confidence: number }> {
  if (recentCompletedTasks.length === 0) {
    return { taskId: null, confidence: 0 };
  }

  // If only one candidate, return it with high confidence
  if (recentCompletedTasks.length === 1) {
    return { taskId: recentCompletedTasks[0].id, confidence: 0.9 };
  }

  // Use LLM to find the best semantic match
  const prompt = `You are a dependency resolver. Given a dependency label and a list of completed tasks, find the best semantic match.

Dependency label: "${label}"

Completed tasks (most recent first):
${recentCompletedTasks
  .slice(0, 10)
  .map((t, i) => `${i + 1}. Task ID ${t.id}: "${t.description}"`)
  .join("\n")}

Return a JSON object:
{
  "taskId": <ID of the best matching task, or null if no good match>,
  "confidence": <0–1, how confident you are>,
  "reasoning": "<why this is the best match>"
}

Rules:
1. Only return a taskId if you are confident (confidence >= 0.7) that it matches the label.
2. Consider semantic similarity, not exact string matching.
3. If no task is a good match, return taskId: null.
4. Be conservative — a wrong match is worse than no match.`;

  try {
    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        taskId: result.taskId || null,
        confidence: Math.max(0, Math.min(1, result.confidence || 0)),
      };
    }
  } catch (error) {
    console.warn("[Cross-Cycle Resolver] Error resolving label:", error);
  }

  return { taskId: null, confidence: 0 };
}

/**
 * Batch resolve multiple dependency labels.
 */
export async function resolveDependencyLabels(
  labels: string[],
  recentCompletedTasks: Array<{ id: number; description: string }>
): Promise<Map<string, { taskId: number | null; confidence: number }>> {
  const results = new Map<string, { taskId: number | null; confidence: number }>();

  for (const label of labels) {
    const resolution = await resolveDependencyLabel(label, recentCompletedTasks);
    results.set(label, resolution);
  }

  return results;
}

/**
 * Validate that a resolved dependency makes semantic sense.
 * Used to double-check before persisting the dependency.
 */
export async function validateDependencyMatch(
  label: string,
  taskId: number,
  taskDescription: string
): Promise<boolean> {
  const prompt = `Does this task match the dependency label?

Dependency label: "${label}"
Task ID ${taskId}: "${taskDescription}"

Return a JSON object:
{
  "matches": <true or false>,
  "confidence": <0–1>,
  "reasoning": "<brief explanation>"
}`;

  try {
    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return result.matches && result.confidence >= 0.7;
    }
  } catch (error) {
    console.warn("[Cross-Cycle Resolver] Error validating match:", error);
  }

  return false;
}

/**
 * Find all completed tasks that might match a dependency label.
 * Returns top N candidates sorted by relevance.
 */
export async function findCandidateTasks(
  label: string,
  allCompletedTasks: Array<{ id: number; description: string }>,
  topN: number = 5
): Promise<SemanticMatch[]> {
  if (allCompletedTasks.length === 0) {
    return [];
  }

  const prompt = `Given a dependency label and a list of completed tasks, rank the tasks by how well they match the label.

Dependency label: "${label}"

Completed tasks:
${allCompletedTasks
  .slice(0, 20)
  .map((t) => `Task ID ${t.id}: "${t.description}"`)
  .join("\n")}

Return a JSON array of the top ${topN} matches:
[
  {
    "taskId": <ID>,
    "matchScore": <0–1>,
    "reasoning": "<why this matches>"
  }
]

Rules:
1. Only include tasks with matchScore >= 0.6.
2. Sort by matchScore descending.
3. Return at most ${topN} matches.`;

  try {
    const response = await invokeLLM({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);

    if (jsonMatch) {
      const matches = JSON.parse(jsonMatch[0]) as Array<{
        taskId: number;
        matchScore: number;
        reasoning: string;
      }>;

      return matches
        .map((m) => ({
          taskId: m.taskId,
          taskDescription: allCompletedTasks.find((t) => t.id === m.taskId)?.description || "",
          matchScore: Math.max(0, Math.min(1, m.matchScore)),
          reasoning: m.reasoning,
        }))
        .filter((m) => m.taskDescription)
        .slice(0, topN);
    }
  } catch (error) {
    console.warn("[Cross-Cycle Resolver] Error finding candidates:", error);
  }

  return [];
}
