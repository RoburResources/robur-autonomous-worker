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
