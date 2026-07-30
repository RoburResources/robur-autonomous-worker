/**
 * Tests for conversational SMS and Retell webhook handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createTask: vi.fn(),
  createTaskOnce: vi.fn(),
  logExecution: vi.fn(),
  getConfig: vi.fn(),
}));

const twilioMocks = vi.hoisted(() => ({
  sendSMS: vi.fn(),
  isVerifiedOwnerSmsRequest: vi.fn(),
  isVerifiedOwnerVoiceRequest: vi.fn(),
  parseInboundSMS: vi.fn(),
  claimInboundSms: vi.fn(),
}));

const llmMocks = vi.hoisted(() => ({
  invokeLLM: vi.fn(),
}));
const gateMocks = vi.hoisted(() => ({
  getLegacyWorkerRuntimeGate: vi.fn(),
}));

vi.mock("../db", () => dbMocks);
vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../_core/llm", () => llmMocks);
vi.mock("../safety/legacyWorkerGate", () => gateMocks);

import { isStructuredCommand, handleConversationalSMS } from "./smsConversation";

beforeEach(() => {
  gateMocks.getLegacyWorkerRuntimeGate.mockResolvedValue({ allowed: true });
});

describe("isStructuredCommand", () => {
  it("identifies STOP as a structured command", () => {
    expect(isStructuredCommand("STOP")).toBe(true);
    expect(isStructuredCommand("stop")).toBe(true);
  });

  it("identifies START as a structured command", () => {
    expect(isStructuredCommand("START")).toBe(true);
  });

  it("identifies APPROVE as a structured command", () => {
    expect(isStructuredCommand("APPROVE 123")).toBe(true);
    expect(isStructuredCommand("APPROVE")).toBe(true);
  });

  it("identifies REJECT as a structured command", () => {
    expect(isStructuredCommand("REJECT 456")).toBe(true);
  });

  it("identifies STATUS as a structured command", () => {
    expect(isStructuredCommand("STATUS")).toBe(true);
  });

  it("does not classify natural language as structured command", () => {
    expect(isStructuredCommand("Call the Bangladesh buyers")).toBe(false);
    expect(isStructuredCommand("Research scrap metal prices")).toBe(false);
    expect(isStructuredCommand("TASKS")).toBe(false);
    expect(isStructuredCommand("DONE")).toBe(false);
  });
});

describe("handleConversationalSMS — TASKS command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDb.mockResolvedValue({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        { id: 1, desc: "Research scrap prices", actionType: "web_research", score: 90 },
        { id: 2, desc: "Call Allied Metal", actionType: "outbound_call", score: 85 },
      ]),
    });
    twilioMocks.sendSMS.mockResolvedValue(undefined);
  });

  it("responds with task list for TASKS command", async () => {
    await handleConversationalSMS("TASKS", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("pending tasks")
    );
  });

  it("responds with task list for QUEUE command", async () => {
    await handleConversationalSMS("QUEUE", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("pending tasks")
    );
  });
});

describe("handleConversationalSMS — DONE command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getDb.mockResolvedValue({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        { id: 10, desc: "Researched Bangladesh buyers", actionType: "web_research" },
      ]),
    });
    twilioMocks.sendSMS.mockResolvedValue(undefined);
  });

  it("responds with completed tasks for DONE command", async () => {
    await handleConversationalSMS("DONE", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("completed")
    );
  });
});

describe("handleConversationalSMS — HELP command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    twilioMocks.sendSMS.mockResolvedValue(undefined);
  });

  it("responds with help text for HELP command", async () => {
    await handleConversationalSMS("HELP", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("Commands")
    );
  });

  it("responds with help text for ? command", async () => {
    await handleConversationalSMS("?", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("Commands")
    );
  });
});

describe("handleConversationalSMS — Natural language instruction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getConfig.mockResolvedValue(null);
    dbMocks.createTask.mockResolvedValue([{ insertId: 999 }]);
    dbMocks.createTaskOnce.mockResolvedValue({ created: true, taskId: 999 });
    twilioMocks.sendSMS.mockResolvedValue(undefined);
    llmMocks.invokeLLM.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            tasks: [{
              description: "Research current scrap metal prices in Perth",
              actionType: "web_research",
              priorityScore: 85,
              estimatedValue: 5000,
            }],
            reply: "On it, I'll research those prices now."
          })
        }
      }]
    });
  });

  it("creates a task from natural language instruction", async () => {
    await handleConversationalSMS("Research scrap metal prices in Perth", "+61495007200");
    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("scrap metal prices"),
        actionType: "web_research",
        source: "sms_instruction",
      })
    );
  });

  it("sends confirmation SMS after creating task", async () => {
    await handleConversationalSMS("Research scrap metal prices in Perth", "+61495007200");
    expect(twilioMocks.sendSMS).toHaveBeenCalledWith(
      "+61495007200",
      expect.stringContaining("Addison")
    );
  });

  it("falls back to generic task when LLM fails", async () => {
    llmMocks.invokeLLM.mockRejectedValue(new Error("LLM error"));
    await handleConversationalSMS("Do something important", "+61495007200");
    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Do something important"),
        source: "sms_instruction",
      })
    );
  });

  it("uses the provider delivery key to prevent duplicate task creation after a webhook retry", async () => {
    await handleConversationalSMS(
      "Research scrap metal prices in Perth",
      "+61495007200",
      "twilio:SM00000000000000000000000000000000"
    );

    expect(dbMocks.createTask).not.toHaveBeenCalled();
    expect(dbMocks.createTaskOnce).toHaveBeenCalledWith(
      "twilio:SM00000000000000000000000000000000:task:0",
      expect.objectContaining({
        description: expect.stringContaining("scrap metal prices"),
        source: "sms_instruction",
      })
    );
  });

  it("canonicalizes an owner email instruction to the executor email payload", async () => {
    llmMocks.invokeLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tasks: [
                {
                  description: "Send the approved project update to the owner.",
                  actionType: "send_email",
                  priorityScore: 80,
                  actionPayload: {
                    recipientEmail: "owner@example.test",
                    subject: "Project update",
                  },
                },
              ],
              reply: "I prepared the email task.",
            }),
          },
        },
      ],
    });

    await handleConversationalSMS(
      "Email the project update to owner@example.test",
      "+61495007200"
    );

    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "send_email",
        actionPayload: {
          email: "owner@example.test",
          subject: "Project update",
        },
      })
    );
  });

  it("rejects an oversized model task batch before inserting any model-proposed task", async () => {
    llmMocks.invokeLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tasks: Array.from({ length: 4 }, (_, index) => ({
                description: `Research bounded topic number ${index + 1}`,
                actionType: "web_research",
                priorityScore: 80,
              })),
              reply: "I prepared four tasks.",
            }),
          },
        },
      ],
    });

    await handleConversationalSMS(
      "Research four separate topics",
      "+61495007200"
    );

    expect(dbMocks.createTask).toHaveBeenCalledTimes(1);
    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "[From Tarz SMS] Research four separate topics",
        actionType: "web_research",
      })
    );
  });

  it("validates the whole model batch before inserting its first task", async () => {
    llmMocks.invokeLLM.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              tasks: [
                {
                  description: "Research one bounded internal topic",
                  actionType: "web_research",
                  priorityScore: 80,
                },
                {
                  description: "Send an invalid unbounded task",
                  actionType: "send_sms",
                  priorityScore: 1_000,
                },
              ],
              reply: "I prepared the tasks.",
            }),
          },
        },
      ],
    });

    await handleConversationalSMS(
      "Research one topic and send an update",
      "+61495007200"
    );

    expect(dbMocks.createTask).toHaveBeenCalledTimes(1);
    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "[From Tarz SMS] Research one topic and send an update",
        actionType: "web_research",
      })
    );
  });

  it("does not create a fallback duplicate when only the confirmation reply fails", async () => {
    twilioMocks.sendSMS.mockRejectedValueOnce(
      new Error("confirmation provider unavailable")
    );

    await handleConversationalSMS(
      "Research scrap metal prices in Perth",
      "+61495007200"
    );

    expect(dbMocks.createTask).toHaveBeenCalledTimes(1);
    expect(dbMocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("scrap metal prices"),
      })
    );
  });

  it("stops before task creation and reply when the gate changes during LLM work", async () => {
    gateMocks.getLegacyWorkerRuntimeGate
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: "paused" });

    await handleConversationalSMS(
      "Research a bounded internal topic",
      "+61495007200"
    );

    expect(llmMocks.invokeLLM).toHaveBeenCalledTimes(1);
    expect(dbMocks.createTask).not.toHaveBeenCalled();
    expect(twilioMocks.sendSMS).not.toHaveBeenCalled();
  });
});

describe("Voice webhook TwiML", () => {
  it("generates valid TwiML for Retell SIP routing", async () => {
    twilioMocks.isVerifiedOwnerVoiceRequest.mockReturnValue(true);
    const { addisonVoiceWebhookHandler } = await import("./voiceWebhook");
    const mockReq = { body: { From: "+61495007200", To: "+61468061765" } } as any;
    const mockRes = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    addisonVoiceWebhookHandler(mockReq, mockRes);

    expect(mockRes.set).toHaveBeenCalledWith("Content-Type", "text/xml");
    expect(mockRes.send).toHaveBeenCalledWith(
      expect.stringContaining("sip.retellai.com")
    );
    expect(mockRes.send).toHaveBeenCalledWith(
      expect.stringContaining("agent_7f02eb1896dd1e6deb38e54942")
    );
  });

  it("rejects an unsigned or non-owner voice webhook", async () => {
    twilioMocks.isVerifiedOwnerVoiceRequest.mockReturnValue(false);
    const { addisonVoiceWebhookHandler } = await import("./voiceWebhook");
    const mockReq = {
      body: { From: "+61400000000", To: "+61468061765" },
    } as any;
    const mockRes = {
      set: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as any;

    addisonVoiceWebhookHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("<Response></Response>");
  });
});
