/**
 * Tests for conversational SMS and Retell webhook handlers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  createTask: vi.fn(),
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

vi.mock("../db", () => dbMocks);
vi.mock("../integrations/twilio", () => twilioMocks);
vi.mock("../_core/llm", () => llmMocks);

import { isStructuredCommand, handleConversationalSMS } from "./smsConversation";

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
