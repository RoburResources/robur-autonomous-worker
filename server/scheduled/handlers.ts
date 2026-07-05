import { Request, Response } from "express";
import { sdk } from "../_core/sdk";
import { runTaskGenerator } from "../autonomous/taskGenerator";
import { runTaskExecutor } from "../autonomous/taskExecutor";
import { runEvaluator } from "../autonomous/evaluator";
import { runSelfImprover } from "../autonomous/selfImprover";
import { runMorningBriefing, runEveningBriefing } from "../autonomous/briefings";

/**
 * Authenticate cron requests
 */
async function authenticateCron(req: Request, res: Response): Promise<boolean> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) {
      res.status(403).json({ error: "cron-only endpoint" });
      return false;
    }
    return true;
  } catch (error: any) {
    res.status(403).json({ error: "Authentication failed", detail: error.message });
    return false;
  }
}

/**
 * Task Generator — hourly
 * POST /api/scheduled/task-generator
 */
export async function taskGeneratorHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runTaskGenerator();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Task generator error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url, taskUid: req.body?.taskUid },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Task Executor — every 15 minutes
 * POST /api/scheduled/task-executor
 */
export async function taskExecutorHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runTaskExecutor();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Task executor error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Evaluator — daily at 6pm AWST (10:00 UTC)
 * POST /api/scheduled/evaluator
 */
export async function evaluatorHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runEvaluator();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Evaluator error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Self-Improver — weekly Sunday
 * POST /api/scheduled/self-improver
 */
export async function selfImproverHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runSelfImprover();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Self-improver error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Morning Briefing — 8:00am AWST (00:00 UTC)
 * POST /api/scheduled/morning-briefing
 */
export async function morningBriefingHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runMorningBriefing();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Morning briefing error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Evening Briefing — 5:30pm AWST (09:30 UTC)
 * POST /api/scheduled/evening-briefing
 */
export async function eveningBriefingHandler(req: Request, res: Response) {
  try {
    if (!(await authenticateCron(req, res))) return;
    const result = await runEveningBriefing();
    res.json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (error: any) {
    console.error("[Scheduled] Evening briefing error:", error);
    res.status(500).json({
      error: error.message,
      stack: error.stack,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
