import { createHash } from "node:crypto";
import { normalizeTaskMetadata } from "../autonomous/taskMetadata";

export type ExternalTaskApprovalSubject = {
  id: number;
  source?: unknown;
  description?: unknown;
  actionType?: unknown;
  actionPayload?: unknown;
  metadata?: unknown;
  estimatedValue?: unknown;
};

export type ExternalApprovalArtifact = {
  version: 1;
  sourceFingerprint: string;
  actionType: "outbound_call" | "send_email" | "send_sms";
  target: string;
  content: string;
  subject?: string;
  targetName?: string;
  templateType?: string;
  experimentId?: string;
  variantId?: string;
  providerIdentity:
    | {
        provider: "retell";
        from: string;
        agentId: string;
        agentVersion: number;
        agentConfigSha256: string;
        scriptVariable: "approved_script";
      }
    | {
        provider: "sendgrid";
        from: string;
        fromName: string;
      }
    | {
        provider: "twilio";
        from: string;
      };
};

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => [key, canonicalJsonValue(record[key])])
  );
}

function digestCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)), "utf8")
    .digest("hex");
}

export function externalTaskApprovalSourceFingerprint(
  task: ExternalTaskApprovalSubject
): string {
  const metadata = normalizeTaskMetadata(task.metadata);
  const approvalRelevantMetadata = {
    contactName: metadata.contactName,
    emailTemplate: metadata.emailTemplate,
    recipientEmail: metadata.recipientEmail,
    recipientName: metadata.recipientName,
  };
  return digestCanonical({
    version: 2,
    taskId: task.id,
    source: task.source,
    description: task.description,
    actionType: task.actionType,
    actionPayload: task.actionPayload,
    estimatedValue: task.estimatedValue,
    metadata: approvalRelevantMetadata,
  });
}

export function externalApprovalArtifact(
  task: ExternalTaskApprovalSubject
): ExternalApprovalArtifact | null {
  const metadata = normalizeTaskMetadata(task.metadata);
  const value = metadata.external_approval_artifact;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifact = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "version",
    "sourceFingerprint",
    "actionType",
    "target",
    "content",
    "subject",
    "targetName",
    "templateType",
    "experimentId",
    "variantId",
    "providerIdentity",
  ]);
  if (Object.keys(artifact).some(key => !allowedKeys.has(key))) return null;
  if (
    artifact.version !== 1 ||
    artifact.sourceFingerprint !==
      externalTaskApprovalSourceFingerprint(task) ||
    (artifact.actionType !== "outbound_call" &&
      artifact.actionType !== "send_email" &&
      artifact.actionType !== "send_sms") ||
    artifact.actionType !== task.actionType ||
    typeof artifact.target !== "string" ||
    artifact.target.length < 1 ||
    artifact.target.length > 320 ||
    typeof artifact.content !== "string" ||
    artifact.content.length < 1 ||
    artifact.content.length > 4_000
  ) {
    return null;
  }
  for (const key of ["subject", "targetName", "templateType"] as const) {
    if (
      artifact[key] !== undefined &&
      (typeof artifact[key] !== "string" || artifact[key].length > 500)
    ) {
      return null;
    }
  }
  for (const key of ["experimentId", "variantId"] as const) {
    if (
      artifact[key] !== undefined &&
      (typeof artifact[key] !== "string" ||
        artifact[key].length < 1 ||
        artifact[key].length > 200)
    ) {
      return null;
    }
  }
  if (artifact.providerIdentity === undefined) return null;
  {
    if (
      !artifact.providerIdentity ||
      typeof artifact.providerIdentity !== "object" ||
      Array.isArray(artifact.providerIdentity)
    ) {
      return null;
    }
    const identity = artifact.providerIdentity as Record<string, unknown>;
    const e164 = /^\+[1-9]\d{7,14}$/;
    if (
      artifact.actionType === "outbound_call" &&
      (identity.provider !== "retell" ||
        Object.keys(identity).some(
          key =>
            ![
              "provider",
              "from",
              "agentId",
              "agentVersion",
              "agentConfigSha256",
              "scriptVariable",
            ].includes(key)
        ) ||
        typeof identity.from !== "string" ||
        !e164.test(identity.from) ||
        typeof identity.agentId !== "string" ||
        !/^agent_[A-Za-z0-9_-]{8,190}$/.test(identity.agentId) ||
        !Number.isInteger(identity.agentVersion) ||
        (identity.agentVersion as number) < 0 ||
        (identity.agentVersion as number) > 1_000_000 ||
        typeof identity.agentConfigSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(identity.agentConfigSha256) ||
        identity.scriptVariable !== "approved_script")
    ) {
      return null;
    }
    if (
      artifact.actionType === "send_email" &&
      (identity.provider !== "sendgrid" ||
        Object.keys(identity).some(
          key => !["provider", "from", "fromName"].includes(key)
        ) ||
        typeof identity.from !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.from) ||
        identity.from.length > 320 ||
        typeof identity.fromName !== "string" ||
        identity.fromName.length < 1 ||
        identity.fromName.length > 200)
    ) {
      return null;
    }
    if (
      artifact.actionType === "send_sms" &&
      (identity.provider !== "twilio" ||
        Object.keys(identity).some(
          key => !["provider", "from"].includes(key)
        ) ||
        typeof identity.from !== "string" ||
        !e164.test(identity.from))
    ) {
      return null;
    }
  }
  return artifact as ExternalApprovalArtifact;
}

export function externalTaskApprovalFingerprint(
  task: ExternalTaskApprovalSubject
): string {
  return digestCanonical({
    version: 2,
    sourceFingerprint: externalTaskApprovalSourceFingerprint(task),
    artifact: externalApprovalArtifact(task),
  });
}
