/**
 * Dependency Linker — Part A of DAG resolution.
 * After generating a batch of tasks in a single cycle, resolves numeric task IDs for dependencies.
 * Uses LLM to understand task descriptions and infer dependencies.
 */

import { invokeLLM } from "../_core/llm";
import { getDb } from "../db";

export interface TaskWithDependencies {
  id: number;
  description: string;
  dependencies: string[]; // Labels like "auto_shop_database_complete"
}

export interface DependencyResolution {
  taskId: number;
  dependsOn: number[]; // Numeric task IDs
  confidence: number; // 0–1, how confident the linker is
  reasoning: string;
}

/**
 * Link dependencies within a batch of newly created tasks.
 * Called immediately after task generation, before executor runs.
 */
export async function linkBatchDependencies(
  newTasks: TaskWithDependencies[]
): Promise<DependencyResolution[]> {
  if (newTasks.length === 0) {
    return [];
  }

  // Build a summary of all tasks in the batch for the LLM
  const taskSummary = newTasks
    .map(
      (t) =>
        `Task ID ${t.id}: "${t.description}" (dependencies: ${t.dependencies.join(", ") || "none"})`
    )
    .join("\n");

  const prompt = `You are a dependency linker. Given a batch of newly created tasks, identify which tasks depend on which other tasks in the same batch.

Tasks in this batch:
${taskSummary}

For each task that has dependencies listed, determine which other tasks in the batch it depends on. Return a JSON array with:
[
  {
    "taskId": <number>,
    "dependsOn": [<list of task IDs this task depends on>],
    "confidence": <0–1>,
    "reasoning": "<why this dependency exists>"
  }
]

Rules:
1. Only link tasks that have an explicit dependency label (dependencies field is not empty).
2. A task can only depend on other tasks in this batch (IDs ${newTasks.map((t) => t.id).join(", ")}).
3. Do not create circular dependencies.
4. Be conservative — only create dependencies you are confident about (confidence > 0.7).
5. Return empty array if no dependencies can be resolved.`;

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

    // Parse the response
    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    let resolutions: DependencyResolution[] = [];

    try {
      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        resolutions = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.warn("[Dependency Linker] Failed to parse LLM response:", parseError);
      return [];
    }

    // Validate resolutions
    const validResolutions: DependencyResolution[] = [];
    for (const resolution of resolutions) {
      // Check that task IDs are valid
      if (!newTasks.find((t) => t.id === resolution.taskId)) {
        console.warn(`[Dependency Linker] Invalid taskId: ${resolution.taskId}`);
        continue;
      }

      // Check that dependencies are valid
      const validDeps = resolution.dependsOn.filter((depId) => newTasks.find((t) => t.id === depId));
      if (validDeps.length !== resolution.dependsOn.length) {
        console.warn(
          `[Dependency Linker] Some dependencies invalid for task ${resolution.taskId}`
        );
      }

      // Check for cycles
      if (hasCycle(resolution.taskId, validDeps, resolutions)) {
        console.warn(`[Dependency Linker] Cycle detected for task ${resolution.taskId}, skipping`);
        continue;
      }

      // Only include if confidence is high enough
      if (resolution.confidence >= 0.7) {
        validResolutions.push({
          ...resolution,
          dependsOn: validDeps,
        });
      }
    }

    return validResolutions;
  } catch (error) {
    console.error("[Dependency Linker] Error linking batch dependencies:", error);
    return [];
  }
}

/**
 * Resolve cross-cycle dependencies by semantic matching.
 * Called when a task has dependency labels but no numeric IDs yet.
 */
export async function resolveCrossCycleDependencies(
  task: TaskWithDependencies,
  dependencyLabels: string[]
): Promise<number[]> {
  if (dependencyLabels.length === 0) {
    return [];
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Dependency Linker] No database connection for cross-cycle resolution");
    return [];
  }

  const resolvedIds: number[] = [];

  for (const label of dependencyLabels) {
    try {
      // Query for completed tasks matching this label
      // Use raw SQL to avoid Drizzle complexity
      const matchingTasks = [] as Array<{ id: number; description: string; status: string }>;
      // TODO: implement actual DB query when Drizzle is properly configured

      // Use LLM to find the best match
      if (matchingTasks.length > 0) {
        const bestMatch = await findBestTaskMatch(label, matchingTasks);
        if (bestMatch) {
          resolvedIds.push(bestMatch);
        }
      }
    } catch (error) {
      console.warn(`[Dependency Linker] Error resolving label "${label}":`, error);
    }
  }

  return resolvedIds;
}

/**
 * Find the best matching task for a dependency label using semantic similarity.
 */
async function findBestTaskMatch(
  label: string,
  candidates: Array<{ id: number; description: string }>
): Promise<number | null> {
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0].id;
  }

  const prompt = `Given a dependency label and a list of completed tasks, find the best match.

Dependency label: "${label}"

Candidate tasks:
${candidates.map((c) => `Task ID ${c.id}: "${c.description}"`).join("\n")}

Return a JSON object with:
{
  "taskId": <the ID of the best matching task>,
  "confidence": <0–1>,
  "reasoning": "<why this is the best match>"
}

Be conservative. If no task is a good match, return taskId: null.`;

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
      if (result.taskId && result.confidence >= 0.7) {
        return result.taskId;
      }
    }
  } catch (error) {
    console.warn("[Dependency Linker] Error finding best match:", error);
  }

  return null;
}

/**
 * Check if adding a dependency would create a cycle.
 */
function hasCycle(
  taskId: number,
  dependsOn: number[],
  allResolutions: DependencyResolution[]
): boolean {
  // Simple cycle detection: if any of our dependencies depend on us, it's a cycle
  for (const depId of dependsOn) {
    const depResolution = allResolutions.find((r) => r.taskId === depId);
    if (depResolution && depResolution.dependsOn.includes(taskId)) {
      return true;
    }
  }
  return false;
}
