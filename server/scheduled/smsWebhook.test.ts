import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const twilioMocks = vi.hoisted(() => ({
  isVerifiedOwnerSmsRequest: vi.fn(),
  parseInboundSMS: vi.fn(),
}));
const inboxMocks = vi.hoisted(() => ({
  enqueueInboundSms: vi.fn(),
  drainInboundSmsInbox: vi.fn(),
}));
const channelMocks = vi.hoisted(() => ({
  ownerSmsChannelCertified: vi.fn(),
}));

vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../safety/smsChannelCertification", () => channelMocks);
vi.mock("./smsWebhookInbox", async importOriginal => {
  const actual = await importOriginal<
    typeof import("./smsWebhookInbox")
  >();
  return {
    ...actual,
    enqueueInboundSms: inboxMocks.enqueueInboundSms,
    drainInboundSmsInbox: inboxMocks.drainInboundSmsInbox,
  };
});

import { smsWebhookHandler } from "./smsWebhook";

function responseMock(events: string[] = []): Response {
  const res = {
    type: vi.fn(() => {
      events.push("content-type");
      return res;
    }),
    status: vi.fn((status: number) => {
      events.push(`status:${status}`);
      return res;
    }),
    send: vi.fn(() => {
      events.push("ack");
      return res;
    }),
  };
  return res as unknown as Response;
}

function validPayload(message = "STATUS") {
  return {
    accountSid: `AC${"a".repeat(32)}`,
    from: "+61400000000",
    to: "+61411111111",
    message,
    messageSid: `SM${"0".repeat(32)}`,
  };
}

describe("durable signed owner SMS ingress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelMocks.ownerSmsChannelCertified.mockReturnValue(true);
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(true);
    twilioMocks.parseInboundSMS.mockReturnValue(validPayload());
    inboxMocks.enqueueInboundSms.mockResolvedValue({
      disposition: "accepted",
      key: "a".repeat(64),
      created: true,
    });
    inboxMocks.drainInboundSmsInbox.mockResolvedValue(1);
  });

  it("stays default-off and returns valid XML without touching authentication", async () => {
    channelMocks.ownerSmsChannelCertified.mockReturnValue(false);
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.type).toHaveBeenCalledWith("text/xml");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith("<Response></Response>");
    expect(twilioMocks.isVerifiedOwnerSmsRequest).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request before parsing or persistence", async () => {
    twilioMocks.isVerifiedOwnerSmsRequest.mockReturnValue(false);
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(twilioMocks.parseInboundSMS).not.toHaveBeenCalled();
    expect(inboxMocks.enqueueInboundSms).not.toHaveBeenCalled();
  });

  it("rejects a malformed SID or oversized body before persistence", async () => {
    twilioMocks.parseInboundSMS.mockReturnValue({
      ...validPayload("x".repeat(1_601)),
      messageSid: "invalid",
    });
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(inboxMocks.enqueueInboundSms).not.toHaveBeenCalled();
  });

  it("persists before acknowledging and starts only the internal worker after ack", async () => {
    const events: string[] = [];
    inboxMocks.enqueueInboundSms.mockImplementation(async () => {
      events.push("persisted");
      return {
        disposition: "accepted",
        key: "a".repeat(64),
        created: true,
      };
    });
    inboxMocks.drainInboundSmsInbox.mockImplementation(async () => {
      events.push("drain");
      return 1;
    });
    const res = responseMock(events);

    await smsWebhookHandler({ body: {} } as Request, res);
    await Promise.resolve();

    expect(events.indexOf("persisted")).toBeLessThan(events.indexOf("ack"));
    expect(events.indexOf("ack")).toBeLessThan(events.indexOf("drain"));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.type).toHaveBeenCalledWith("text/xml");
  });

  it("passes only the bounded authenticated identity to the inbox", async () => {
    const payload = validPayload("START");
    twilioMocks.parseInboundSMS.mockReturnValue(payload);

    await smsWebhookHandler({ body: {} } as Request, responseMock());

    expect(inboxMocks.enqueueInboundSms).toHaveBeenCalledWith(
      payload,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });

  it.each(["completed", "terminal_failure"] as const)(
    "acknowledges a safely terminal %s replay without reprocessing",
    async disposition => {
      inboxMocks.enqueueInboundSms.mockResolvedValue({
        disposition,
        key: "a".repeat(64),
      });
      const res = responseMock();

      await smsWebhookHandler({ body: {} } as Request, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(inboxMocks.drainInboundSmsInbox).not.toHaveBeenCalled();
    }
  );

  it("quarantines a same-SID changed-payload replay", async () => {
    inboxMocks.enqueueInboundSms.mockResolvedValue({
      disposition: "conflict",
      key: "a".repeat(64),
    });
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(inboxMocks.drainInboundSmsInbox).not.toHaveBeenCalled();
  });

  it("returns retryable XML when durable persistence fails", async () => {
    inboxMocks.enqueueInboundSms.mockRejectedValue(
      new Error("database unavailable")
    );
    const res = responseMock();

    await smsWebhookHandler({ body: {} } as Request, res);

    expect(res.type).toHaveBeenCalledWith("text/xml");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).toHaveBeenCalledWith("<Response></Response>");
  });
});
