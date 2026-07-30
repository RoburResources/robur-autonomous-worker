export const PRIVATE_RESEARCH_COMPLETION_CONTRACT_VERSION = 2;
export const PRIVATE_RESEARCH_EVIDENCE_CONTRACT =
  "Use only current publicly accessible sources. A well-supported finding " +
  "that requested information is not publicly disclosed is a complete " +
  "evidence-availability conclusion; do not invent values or require private " +
  "records, external contact, or future access.";
const LEGACY_PRIVATE_RESEARCH_EVIDENCE_SUFFIX =
  `\n\nCompletion contract: ${PRIVATE_RESEARCH_EVIDENCE_CONTRACT}`;
const PRIVATE_RESEARCH_OBJECTIVE_PREFIX =
  `Public-evidence research objective.
Completion contract: ${PRIVATE_RESEARCH_EVIDENCE_CONTRACT}

Original generated objective:
`;

export function withoutPrivateResearchEvidenceContract(
  description: string
): string {
  let objective = description.trim();
  if (objective.startsWith(PRIVATE_RESEARCH_OBJECTIVE_PREFIX)) {
    objective = objective
      .slice(PRIVATE_RESEARCH_OBJECTIVE_PREFIX.length)
      .trim();
  } else if (objective.endsWith(LEGACY_PRIVATE_RESEARCH_EVIDENCE_SUFFIX)) {
    objective = objective
      .slice(0, -LEGACY_PRIVATE_RESEARCH_EVIDENCE_SUFFIX.length)
      .trim();
  }
  return objective;
}

export function withoutPrivateResearchBoilerplateForNovelty(
  description: string
): string {
  return withoutPrivateResearchEvidenceContract(description)
    .replaceAll(PRIVATE_RESEARCH_OBJECTIVE_PREFIX, " ")
    .replaceAll(LEGACY_PRIVATE_RESEARCH_EVIDENCE_SUFFIX, " ")
    .replaceAll(PRIVATE_RESEARCH_EVIDENCE_CONTRACT, " ")
    .replaceAll("Public-evidence research objective.", " ")
    .replaceAll("Completion contract:", " ")
    .replaceAll("Original generated objective:", " ")
    .trim();
}

export function withPrivateResearchEvidenceContract(
  description: string
): string {
  const objective = withoutPrivateResearchEvidenceContract(description);
  if (!objective) return "";
  return `${PRIVATE_RESEARCH_OBJECTIVE_PREFIX}${objective}`;
}

export function hasPrivateResearchEvidenceContract(
  description: string
): boolean {
  const trimmed = description.trim();
  return (
    trimmed.startsWith(PRIVATE_RESEARCH_OBJECTIVE_PREFIX) &&
    trimmed.slice(PRIVATE_RESEARCH_OBJECTIVE_PREFIX.length).trim().length > 0
  );
}
