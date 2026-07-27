/**
 * A/B Testing Framework
 *
 * Automatically tests different variants of call scripts, email subjects,
 * and research approaches. Tracks performance per variant, detects winners
 * with statistical confidence, and feeds results into the self-improver.
 *
 * Architecture:
 * - Experiments are stored in system_config as JSON
 * - Each task execution is assigned a variant deterministically (task ID % variant count)
 * - Outcomes are tracked per variant in the evaluations table
 * - Winner detection uses a simple chi-squared-like comparison after min sample size
 * - Winners are promoted to system_config and stored as strategy insights in Mem0
 */

import { getDb } from "../db";
import { systemConfig, evaluations } from "../../drizzle/schema";
import { eq, like, and, gte } from "drizzle-orm";
import { invokeLLM } from "../_core/llm";
import { storeStrategyInsight } from "../memory/mem0";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ExperimentVariant {
  id: string;
  name: string;
  description: string;
  content: string; // The actual prompt/script/subject line being tested
  weight: number; // Traffic allocation weight (default 1 = equal)
}

export interface Experiment {
  id: string;
  name: string;
  actionType: string; // "outbound_call" | "send_email" | "web_research"
  metric: "success_rate" | "confidence_score" | "task_completion_rate";
  variants: ExperimentVariant[];
  status: "running" | "paused" | "completed";
  minSampleSize: number; // Minimum samples per variant before declaring winner
  startedAt: string;
  completedAt?: string;
  winnerId?: string;
  createdAt: string;
}

export interface VariantResult {
  variantId: string;
  variantName: string;
  samples: number;
  successes: number;
  successRate: number;
  avgConfidence: number;
}

export interface ExperimentResult {
  experimentId: string;
  experimentName: string;
  variants: VariantResult[];
  winner?: VariantResult;
  hasEnoughData: boolean;
  confidenceLevel: "high" | "medium" | "low";
  recommendation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment Storage (system_config table)
// ─────────────────────────────────────────────────────────────────────────────

async function saveExperiment(experiment: Experiment): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const key = `ab_experiment:${experiment.id}`;
  const value = JSON.stringify(experiment);

  await db.insert(systemConfig).values({
    key,
    value,
    description: `A/B Experiment: ${experiment.name}`,
  }).onDuplicateKeyUpdate({ set: { value } });
}

async function loadExperiment(experimentId: string): Promise<Experiment | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, `ab_experiment:${experimentId}`))
    .limit(1);

  if (rows.length === 0) return null;

  try {
    return JSON.parse(rows[0].value) as Experiment;
  } catch {
    return null;
  }
}

async function loadAllExperiments(): Promise<Experiment[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select()
    .from(systemConfig)
    .where(like(systemConfig.key, "ab_experiment:%"));

  const experiments: Experiment[] = [];
  for (const row of rows) {
    try {
      experiments.push(JSON.parse(row.value) as Experiment);
    } catch {
      // skip malformed
    }
  }

  return experiments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant Assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assign a variant to a task deterministically using task ID.
 * This ensures the same task always gets the same variant (idempotent).
 */
export function assignVariant(
  experiment: Experiment,
  taskId: number
): ExperimentVariant {
  const runningVariants = experiment.variants.filter(() => experiment.status === "running");
  if (runningVariants.length === 0) return experiment.variants[0];

  // Weighted assignment: build a cumulative weight array
  const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  const normalised = experiment.variants.map((v) => v.weight / totalWeight);

  // Use task ID modulo to pick a bucket
  const bucket = (taskId % 1000) / 1000; // 0.000 to 0.999
  let cumulative = 0;

  for (let i = 0; i < experiment.variants.length; i++) {
    cumulative += normalised[i];
    if (bucket < cumulative) {
      return experiment.variants[i];
    }
  }

  return experiment.variants[experiment.variants.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome Tracking
// ─────────────────────────────────────────────────────────────────────────────

export interface VariantOutcome {
  experimentId: string;
  variantId: string;
  taskId: number;
  success: boolean;
  confidenceScore: number;
  metadata?: Record<string, unknown>;
}

async function saveVariantOutcome(outcome: VariantOutcome): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const key = `ab_outcome:${outcome.experimentId}:${outcome.variantId}:${outcome.taskId}`;
  const value = JSON.stringify({
    ...outcome,
    recordedAt: new Date().toISOString(),
  });

  await db.insert(systemConfig).values({
    key,
    value,
    description: `A/B Outcome: exp=${outcome.experimentId} variant=${outcome.variantId}`,
  }).onDuplicateKeyUpdate({ set: { value } });
}

async function loadVariantOutcomes(experimentId: string): Promise<VariantOutcome[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select()
    .from(systemConfig)
    .where(like(systemConfig.key, `ab_outcome:${experimentId}:%`));

  const outcomes: VariantOutcome[] = [];
  for (const row of rows) {
    try {
      outcomes.push(JSON.parse(row.value) as VariantOutcome);
    } catch {
      // skip
    }
  }

  return outcomes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Winner Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse experiment results and determine if there's a statistically
 * meaningful winner. Uses a simple relative lift threshold.
 */
export async function analyseExperiment(
  experimentId: string
): Promise<ExperimentResult | null> {
  const experiment = await loadExperiment(experimentId);
  if (!experiment) return null;

  const outcomes = await loadVariantOutcomes(experimentId);

  // Aggregate per variant
  const variantMap = new Map<string, { successes: number; total: number; confidenceSum: number }>();
  for (const variant of experiment.variants) {
    variantMap.set(variant.id, { successes: 0, total: 0, confidenceSum: 0 });
  }

  for (const outcome of outcomes) {
    const stats = variantMap.get(outcome.variantId);
    if (stats) {
      stats.total++;
      if (outcome.success) stats.successes++;
      stats.confidenceSum += outcome.confidenceScore || 0;
    }
  }

  const variantResults: VariantResult[] = experiment.variants.map((v) => {
    const stats = variantMap.get(v.id) || { successes: 0, total: 0, confidenceSum: 0 };
    return {
      variantId: v.id,
      variantName: v.name,
      samples: stats.total,
      successes: stats.successes,
      successRate: stats.total > 0 ? stats.successes / stats.total : 0,
      avgConfidence: stats.total > 0 ? stats.confidenceSum / stats.total : 0,
    };
  });

  const minSamples = experiment.minSampleSize;
  const hasEnoughData = variantResults.every((v) => v.samples >= minSamples);

  if (!hasEnoughData) {
    const shortfall = variantResults.map(
      (v) => `${v.variantName}: ${v.samples}/${minSamples}`
    ).join(", ");
    return {
      experimentId,
      experimentName: experiment.name,
      variants: variantResults,
      hasEnoughData: false,
      confidenceLevel: "low",
      recommendation: `Not enough data yet. Progress: ${shortfall}`,
    };
  }

  // Find the best variant by success rate
  const sorted = [...variantResults].sort((a, b) => b.successRate - a.successRate);
  const best = sorted[0];
  const second = sorted[1];

  // Calculate relative lift
  const lift = second.successRate > 0
    ? (best.successRate - second.successRate) / second.successRate
    : 1;

  let confidenceLevel: "high" | "medium" | "low";
  let winner: VariantResult | undefined;

  if (lift >= 0.2) {
    confidenceLevel = "high";
    winner = best;
  } else if (lift >= 0.1) {
    confidenceLevel = "medium";
    winner = best;
  } else {
    confidenceLevel = "low";
    winner = undefined; // No clear winner
  }

  const recommendation = winner
    ? `Winner: "${winner.variantName}" with ${(winner.successRate * 100).toFixed(1)}% success rate (${(lift * 100).toFixed(1)}% lift over next best). Promote to default.`
    : `No clear winner. Best: "${best.variantName}" (${(best.successRate * 100).toFixed(1)}%) vs "${second.variantName}" (${(second.successRate * 100).toFixed(1)}%). Continue testing.`;

  return {
    experimentId,
    experimentName: experiment.name,
    variants: variantResults,
    winner,
    hasEnoughData: true,
    confidenceLevel,
    recommendation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new A/B experiment.
 */
export async function createExperiment(params: {
  name: string;
  actionType: string;
  metric?: Experiment["metric"];
  variants: Array<{ name: string; description: string; content: string }>;
  minSampleSize?: number;
}): Promise<Experiment> {
  const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const experiment: Experiment = {
    id,
    name: params.name,
    actionType: params.actionType,
    metric: params.metric || "success_rate",
    variants: params.variants.map((v, i) => ({
      id: `${id}_v${i}`,
      name: v.name,
      description: v.description,
      content: v.content,
      weight: 1,
    })),
    status: "running",
    minSampleSize: params.minSampleSize || 10,
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  await saveExperiment(experiment);
  return experiment;
}

/**
 * Get the active experiment for a given action type, if any.
 */
export async function getActiveExperiment(
  actionType: string
): Promise<Experiment | null> {
  const experiments = await loadAllExperiments();
  return experiments.find(
    (e) => e.actionType === actionType && e.status === "running"
  ) || null;
}

/**
 * Record an outcome for an experiment variant.
 */
export async function recordVariantOutcome(params: {
  experimentId: string;
  variantId: string;
  taskId: number;
  success: boolean;
  confidenceScore: number;
}): Promise<void> {
  await saveVariantOutcome(params);

  // Check if we have a winner after this new data point
  const result = await analyseExperiment(params.experimentId);
  if (result?.winner && result.confidenceLevel === "high") {
    const experiment = await loadExperiment(params.experimentId);
    if (experiment && experiment.status === "running") {
      // Mark experiment as completed
      experiment.status = "completed";
      experiment.completedAt = new Date().toISOString();
      experiment.winnerId = result.winner.variantId;
      await saveExperiment(experiment);

      // Store winning strategy in Mem0
      const winnerVariant = experiment.variants.find(
        (v) => v.id === result.winner!.variantId
      );
      if (winnerVariant) {
        await storeStrategyInsight({
          insight: `A/B test winner for ${experiment.actionType}: "${winnerVariant.name}" — ${winnerVariant.description}`,
          evidence: result.recommendation,
          actionType: experiment.actionType,
          confidenceLevel: "high",
        }).catch(() => {});

        // Promote winner to system config
        const db = await getDb();
        if (db) {
          const configKey = `ab_winner_${experiment.actionType}`;
          const configValue = JSON.stringify({
            experimentId: experiment.id,
            variantId: winnerVariant.id,
            variantName: winnerVariant.name,
            content: winnerVariant.content,
            successRate: result.winner!.successRate,
            promotedAt: new Date().toISOString(),
          });
          await db.insert(systemConfig).values({
            key: configKey,
            value: configValue,
            description: `A/B winner for ${experiment.actionType}`,
          }).onDuplicateKeyUpdate({ set: { value: configValue } });
        }

        console.log(`[A/B Testing] Winner promoted: "${winnerVariant.name}" for ${experiment.actionType}`);
      }
    }
  }
}

/**
 * Get the winning variant content for an action type, if a winner has been declared.
 * Returns null if no winner yet.
 */
export async function getWinnerContent(
  actionType: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(systemConfig)
    .where(eq(systemConfig.key, `ab_winner_${actionType}`))
    .limit(1);

  if (rows.length === 0) return null;

  try {
    const winner = JSON.parse(rows[0].value);
    return winner.content || null;
  } catch {
    return null;
  }
}

/**
 * Seed the initial set of experiments for Robur.
 * Called once during system setup.
 */
export async function seedInitialExperiments(): Promise<void> {
  const existing = await loadAllExperiments();
  if (existing.length > 0) return; // Already seeded

  // Experiment 1: Call script approaches
  await createExperiment({
    name: "Call Script: Direct vs Value-First",
    actionType: "outbound_call",
    minSampleSize: 5,
    variants: [
      {
        name: "Direct Ask",
        description: "Lead with what we want — direct and efficient",
        content: "Hi, this is Michael from Robur Resources. We're a scrap metal recycler in Perth and we're looking to collect any scrap metal you have available. Do you have any scrap we can pick up?",
      },
      {
        name: "Value-First",
        description: "Lead with the value we provide before asking",
        content: "Hi, this is Michael from Robur Resources. We offer free scrap metal collection for businesses in Perth — we handle all the logistics and you get paid for your materials. Would that be useful for your business?",
      },
      {
        name: "Problem-Solution",
        description: "Start by identifying their pain point",
        content: "Hi, this is Michael from Robur Resources. I'm calling because many businesses in your area are paying to dispose of scrap metal when they could actually be getting paid for it. Is that something you'd want to know more about?",
      },
    ],
  });

  // Experiment 2: Email subject lines
  await createExperiment({
    name: "Email Subject: Benefit vs Curiosity vs Direct",
    actionType: "send_email",
    minSampleSize: 5,
    variants: [
      {
        name: "Benefit-Led",
        description: "Lead with the financial benefit",
        content: "Get paid for your scrap metal — free collection in Perth",
      },
      {
        name: "Curiosity",
        description: "Pique curiosity without revealing the offer",
        content: "Quick question about your metal waste",
      },
      {
        name: "Direct Business",
        description: "Professional and direct",
        content: "Scrap metal collection partnership — Robur Resources Perth",
      },
    ],
  });

  // Experiment 3: Research approach
  await createExperiment({
    name: "Research: Broad vs Targeted",
    actionType: "web_research",
    minSampleSize: 5,
    variants: [
      {
        name: "Broad Sweep",
        description: "Research a wide area to find leads",
        content: "Search broadly for all businesses in the target category across Perth metro, then filter for likely scrap generators.",
      },
      {
        name: "Targeted Deep-Dive",
        description: "Research specific high-value targets in depth",
        content: "Focus on the top 5 highest-value targets in the category. Research each one thoroughly: size, contact details, estimated scrap volume, best approach.",
      },
    ],
  });

  console.log("[A/B Testing] Initial experiments seeded");
}

/**
 * Get all experiment results for the self-improver to analyse.
 */
export async function getAllExperimentResults(): Promise<ExperimentResult[]> {
  const experiments = await loadAllExperiments();
  const results: ExperimentResult[] = [];

  for (const exp of experiments) {
    const result = await analyseExperiment(exp.id);
    if (result) results.push(result);
  }

  return results;
}
