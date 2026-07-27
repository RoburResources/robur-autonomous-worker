import type { NextFunction, Request, Response } from "express";

const INTERNAL_ONLY_ACTION_TYPES = new Set(["web_research", "data_entry"]);

export function isPrivateCandidateInternalOnly(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.PRIVATE_CANDIDATE_INTERNAL_ONLY === "true";
}

export function isPrivateCandidateInternalAction(actionType?: string | null): boolean {
  return INTERNAL_ONLY_ACTION_TYPES.has(actionType || "");
}

export function privateCandidateInternalAutonomyEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.PRIVATE_CANDIDATE_INTERNAL_AUTONOMY === "true" &&
    isPrivateCandidateInternalOnly(env)
  );
}

/**
 * A private candidate must never become a provider webhook target. This
 * middleware is deliberately mounted over the whole provider webhook tree so
 * a future route cannot accidentally bypass the containment policy.
 */
export function blockPrivateCandidateProviderIngress(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isPrivateCandidateInternalOnly()) {
    res
      .status(403)
      .json({ error: "Provider webhooks disabled in private candidate" });
    return;
  }

  next();
}
