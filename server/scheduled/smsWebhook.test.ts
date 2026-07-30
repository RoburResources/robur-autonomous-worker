import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const twilioMocks = vi.hoisted(() => ({
  isVerifiedOwnerSmsRequest: vi.fn(),
  parseInboundSMS: vi.fn(),
  sendSMS: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  acquireInboundSms: vi.fn(),
  completeInboundSms: vi.fn(),
  getConfig: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  updateTaskByOwnerWithAudit: vi.fn(),
  logExecution: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
  pauseLegacyWorker: vi.fn(),
  resumeLegacyWorkerByVerifiedOwner: vi.fn(),
}));
const conversationMocks = vi.hoisted(() => ({
  handleConversationalSMS: vi.fn(),
}));

vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../db", () => dbMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);
vi.mock("./smsConversation", () => conversationMocks);

import { smsWebhookHandler } from "./smsWebhook";

function responseMock(): Response {
  const res = {
    status: vi.fn(),
    send: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as Response;
}

describe("signed owner SMS controls", () => {
  const approvalFingerprint = "a".repeat(64);
  const approvalRequestId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_SMS_COMMAND_CHANNEL_CERTIFIED = "true";
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "START",
      messageSid: "SM00000000000000000000000000000000",
    });
    dbMocks.acquireInboundSms.mockResolvedValue({
      disposition: "acquired",
      token: "22222222-2222-4222-8222-222222222222",
      leaseUntil: "2026-07-30T00:10:00.000Z",
    });
    dbMocks.completeInboundSms.mockResolvedValue(true);
    dbMocks.updateTaskByOwnerWithAudit.mockResolvedValue({
      outcome: "updated",
      previousStatus: "awaiting_approval",
      nextStatus: "pending",
      statusChanged: true,
    });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
  });

  it("keeps the owner SMS command channel disabled until separately certified", async () => {
    delete process.env.OWNER_SMS_COMMAND_CHANNEL_CERTIFIED;
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(twilioMocks.isVerifiedOwnerSmsRequest).not.toHaveBeenCalled();
  });

  it("never resumes or sends a reply for an unauthenticated START", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(false);
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(gateMocks.resumeLegacyWorkerByVerifiedOwner).not.toHaveBeenCalled();
    expect(dbMocks.updateTask).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("resumes only after the signed owner request has been verified", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(gateMocks.resumeLegacyWorkerByVerifiedOwner).toHaveBeenCalledWith(
      "sms:+61400000000"
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not approve an ambiguous latest task", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "APPROVE",
      messageSid: "SM00000000000000000000000000000001",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(dbMocks.getTaskById).not.toHaveBeenCalled();
    expect(dbMocks.updateTask).not.toHaveBeenCalled();
  });

  it("binds approval to the exact awaiting task ID", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: `APPROVE 42 ${approvalFingerprint} ${approvalRequestId}`,
      messageSid: "SM00000000000000000000000000000002",
    });
    dbMocks.getTaskById.mockResolvedValue({
      id: 42,
      status: "awaiting_approval",
      description: "A specifically identified task",
      actionType: "send_sms",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(dbMocks.getTaskById).toHaveBeenCalledWith(42);
    expect(dbMocks.updateTaskByOwnerWithAudit).toHaveBeenCalledWith(42, {
      status: "pending",
      expectedStatus: "awaiting_approval",
      approvalFingerprint,
      approvalRequestId,
      approvalSource: "verified_sms",
    });
    expect(dbMocks.updateTask).not.toHaveBeenCalled();
  });

  it("does not approve an external artifact without the exact message token", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "APPROVE 42",
      messageSid: "SM00000000000000000000000000000022",
    });
    dbMocks.getTaskById.mockResolvedValue({
      id: 42,
      status: "awaiting_approval",
      description: "A specifically identified external task",
      actionType: "send_sms",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(dbMocks.updateTaskByOwnerWithAudit).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61400000000",
      expect.stringContaining("exact approval token")
    );
  });

  it("keeps a substituted task paused when the shown approval fingerprint is stale", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: `APPROVE 42 ${approvalFingerprint} ${approvalRequestId}`,
      messageSid: "SM00000000000000000000000000000003",
    });
    dbMocks.getTaskById.mockResolvedValue({
      id: 42,
      status: "awaiting_approval",
      description: "A changed task",
      actionType: "send_sms",
    });
    dbMocks.updateTaskByOwnerWithAudit.mockResolvedValue({
      outcome: "approval_stale",
      previousStatus: "awaiting_approval",
      nextStatus: "pending",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(dbMocks.updateTaskByOwnerWithAudit).toHaveBeenCalledWith(42, {
      status: "pending",
      expectedStatus: "awaiting_approval",
      approvalFingerprint,
      approvalRequestId,
      approvalSource: "verified_sms",
    });
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61400000000",
      expect.stringContaining("changed after approval was requested")
    );
    expect(twilioMocks.sendSMS).not.toHaveBeenCalledWith(
      "+61400000000",
      expect.stringContaining("approved")
    );
  });

  it("ignores a replayed signed owner command", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    dbMocks.acquireInboundSms.mockResolvedValue({
      disposition: "completed",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(gateMocks.resumeLegacyWorkerByVerifiedOwner).not.toHaveBeenCalled();
    expect(dbMocks.updateTask).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("reinforces STOP and asks Twilio to retry while another lease is processing", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "STOP",
      messageSid: "SM00000000000000000000000000000005",
    });
    dbMocks.acquireInboundSms.mockResolvedValue({
      disposition: "processing",
    });
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(gateMocks.pauseLegacyWorker).toHaveBeenCalledWith(
      "Paused by verified owner via signed SMS retry"
    );
    expect(dbMocks.completeInboundSms).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("does not acknowledge STOP when its exact completion fence is lost", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "STOP",
      messageSid: "SM00000000000000000000000000000006",
    });
    dbMocks.completeInboundSms.mockResolvedValue(false);
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(gateMocks.pauseLegacyWorker).toHaveBeenCalledWith(
      "Paused by verified owner via signed SMS"
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("does not dispatch free text while the runtime gate is paused", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "Research the current market",
      messageSid: "SM00000000000000000000000000000004",
    });
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({
      allowed: false,
      reason: "paused",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(conversationMocks.handleConversationalSMS).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("awaits idempotent conversational processing before completing the delivery lease", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "Research the current market",
      messageSid: "SM00000000000000000000000000000007",
    });
    conversationMocks.handleConversationalSMS.mockResolvedValue(undefined);

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(conversationMocks.handleConversationalSMS).toHaveBeenCalledWith(
      "Research the current market",
      "+61400000000",
      "twilio:SM00000000000000000000000000000007"
    );
    expect(dbMocks.completeInboundSms).toHaveBeenCalledWith(
      "SM00000000000000000000000000000007",
      "22222222-2222-4222-8222-222222222222"
    );
  });
});
