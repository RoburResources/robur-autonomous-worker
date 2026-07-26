import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const twilioMocks = vi.hoisted(() => ({
  isVerifiedOwnerSmsRequest: vi.fn(),
  parseInboundSMS: vi.fn(),
  sendSMS: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  claimInboundSms: vi.fn(),
  getConfig: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  logExecution: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
  pauseLegacyWorker: vi.fn(),
  resumeLegacyWorkerByVerifiedOwner: vi.fn(),
}));

vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../db", () => dbMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);

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
  beforeEach(() => {
    vi.clearAllMocks();
    twilioMocks.parseInboundSMS.mockReturnValue({
      from: "+61400000000",
      message: "START",
      messageSid: "SM00000000000000000000000000000000",
    });
    dbMocks.claimInboundSms.mockResolvedValue(true);
    gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
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
      message: "APPROVE 42",
      messageSid: "SM00000000000000000000000000000002",
    });
    dbMocks.getTaskById.mockResolvedValue({
      id: 42,
      status: "awaiting_approval",
      description: "A specifically identified task",
    });

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(dbMocks.getTaskById).toHaveBeenCalledWith(42);
    expect(dbMocks.updateTask).toHaveBeenCalledWith(42, { status: "pending" });
  });

  it("ignores a replayed signed owner command", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    dbMocks.claimInboundSms.mockResolvedValue(false);

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(gateMocks.resumeLegacyWorkerByVerifiedOwner).not.toHaveBeenCalled();
    expect(dbMocks.updateTask).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });
});
