import { describe, expect, it } from "vitest";
import {
  externalApprovalArtifact,
  externalTaskApprovalFingerprint,
  externalTaskApprovalSourceFingerprint,
} from "./externalTaskApproval";

const task = {
  id: 42,
  source: "manual",
  description: "Send the approved collection update.",
  actionType: "send_sms",
  actionPayload: {
    phoneNumber: "+61400000000",
    message: "Collection is booked.",
  },
  metadata: { contactName: "Supplier" },
  estimatedValue: "250",
};

describe("external task approval fingerprint", () => {
  it("is deterministic across object key order", () => {
    expect(externalTaskApprovalFingerprint(task)).toBe(
      externalTaskApprovalFingerprint({
        ...task,
        actionPayload: {
          message: "Collection is booked.",
          phoneNumber: "+61400000000",
        },
      })
    );
  });

  it.each([
    { actionPayload: { ...task.actionPayload, phoneNumber: "+61400000001" } },
    { actionPayload: { ...task.actionPayload, message: "Different message" } },
    { description: "Send a different update." },
    { actionType: "outbound_call" },
    { id: 43 },
  ])("changes when an approved effect-defining field changes", change => {
    expect(
      externalTaskApprovalFingerprint({ ...task, ...change })
    ).not.toBe(externalTaskApprovalFingerprint(task));
  });

  it("ignores executor-owned transient metadata", () => {
    expect(
      externalTaskApprovalFingerprint({
        ...task,
        metadata: {
          ...task.metadata,
          execution_claim_token: "ephemeral",
          premortem_confidence: 0.9,
          verification_result: { verified: true },
        },
      })
    ).toBe(externalTaskApprovalFingerprint(task));
  });

  it("binds the fingerprint to the exact final provider payload", () => {
    const artifact = {
      version: 1 as const,
      sourceFingerprint: externalTaskApprovalSourceFingerprint(task),
      actionType: "send_sms" as const,
      target: "+61400000000",
      content: "[Robur AI] Collection is booked.",
      providerIdentity: {
        provider: "twilio" as const,
        from: "+61411111111",
      },
    };
    const prepared = {
      ...task,
      metadata: {
        ...task.metadata,
        external_approval_artifact: artifact,
      },
    };
    const changed = {
      ...prepared,
      metadata: {
        ...prepared.metadata,
        external_approval_artifact: {
          ...artifact,
          content: "[Robur AI] Collection date changed.",
        },
      },
    };

    expect(externalApprovalArtifact(prepared)).toEqual(artifact);
    expect(externalTaskApprovalFingerprint(changed)).not.toBe(
      externalTaskApprovalFingerprint(prepared)
    );
    expect(
      externalTaskApprovalFingerprint({
        ...prepared,
        metadata: {
          ...prepared.metadata,
          external_approval_artifact: {
            ...artifact,
            providerIdentity: {
              ...artifact.providerIdentity,
              from: "+61422222222",
            },
          },
        },
      })
    ).not.toBe(externalTaskApprovalFingerprint(prepared));
  });

  it("rejects artifacts with a stale source binding or undeclared fields", () => {
    const artifact = {
      version: 1 as const,
      sourceFingerprint: externalTaskApprovalSourceFingerprint(task),
      actionType: "send_sms" as const,
      target: "+61400000000",
      content: "[Robur AI] Collection is booked.",
      providerIdentity: {
        provider: "twilio" as const,
        from: "+61411111111",
      },
    };

    expect(
      externalApprovalArtifact({
        ...task,
        metadata: {
          external_approval_artifact: {
            ...artifact,
            sourceFingerprint: "0".repeat(64),
          },
        },
      })
    ).toBeNull();
    expect(
      externalApprovalArtifact({
        ...task,
        metadata: {
          external_approval_artifact: {
            ...artifact,
            unapprovedHtml: "<p>Different content</p>",
          },
        },
      })
    ).toBeNull();
  });
});
