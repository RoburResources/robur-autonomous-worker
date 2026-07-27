/**
 * Structured executor — refactored action handlers that return typed StructuredOutput objects.
 * Each action type returns a formal contract matching the schema in shared/actionTypes.ts.
 */

import { invokeLLM } from "../_core/llm";
import {
  StructuredActionOutput,
  WebResearchOutput,
  DataEntryOutput,
  OutboundCallOutput,
  SendEmailOutput,
  SendSmsOutput,
  CodeGenerationOutput,
  FileProcessingOutput,
} from "../../shared/actionTypes";

/**
 * Web research executor — returns structured findings with sources and confidence.
 */
export async function executeWebResearch(
  description: string,
  context?: string
): Promise<WebResearchOutput> {
  const startTime = Date.now();

  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "user",
          content: `Research task: ${description}\n\nContext: ${context || "None"}\n\nProvide findings as a JSON object with: findings (array of strings), sourcesConsulted (array), dataPoints (number), confidence (0-1).`,
        },
      ],
    });

    // Extract text from response
    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // Fallback if response is not JSON
      parsed = {
        findings: [responseText.substring(0, 200)],
        sourcesConsulted: ["LLM"],
        dataPoints: 1,
        confidence: 0.5,
      };
    }

    return {
      success: true,
      summary: `Research completed: ${parsed.findings.length} findings from ${parsed.sourcesConsulted.length} sources`,
      structured: {
        findings: parsed.findings,
        sourcesConsulted: parsed.sourcesConsulted,
        dataPoints: parsed.dataPoints,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        nextActions: parsed.nextActions,
      },
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Research failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        findings: [],
        sourcesConsulted: [],
        dataPoints: 0,
        confidence: 0,
      },
      errorCode: "WEB_RESEARCH_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Data entry executor — returns structured record counts and validation results.
 */
export async function executeDataEntry(
  description: string,
  data: Record<string, unknown>[]
): Promise<DataEntryOutput> {
  const startTime = Date.now();

  try {
    // Simulate data entry validation
    let recordsCreated = 0;
    let recordsUpdated = 0;
    let recordsSkipped = 0;
    const validationErrors: string[] = [];

    for (const record of data) {
      if (!record.id) {
        recordsCreated++;
      } else {
        recordsUpdated++;
      }
    }

    const successRate = (recordsCreated + recordsUpdated) / (data.length || 1);

    return {
      success: successRate > 0.8,
      summary: `Data entry: ${recordsCreated} created, ${recordsUpdated} updated, ${recordsSkipped} skipped`,
      structured: {
        recordsCreated,
        recordsUpdated,
        recordsSkipped,
        validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        successRate,
        sampleRecords: data.slice(0, 3),
      },
      confidence: successRate,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Data entry failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: 0,
        successRate: 0,
      },
      errorCode: "DATA_ENTRY_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Outbound call executor — returns structured call result.
 */
export async function executeOutboundCall(
  phoneNumber: string,
  agentId: string,
  briefing: string
): Promise<OutboundCallOutput> {
  const startTime = Date.now();

  try {
    // Placeholder: in production, this calls Retell AI
    const callStatus: "connected" | "voicemail" | "busy" | "no_answer" | "failed" = "connected";

    return {
      success: callStatus === "connected",
      summary: `Call to ${phoneNumber}: ${callStatus}`,
      structured: {
        phoneNumber,
        callStatus,
        callDuration: callStatus === "connected" ? 180 : undefined,
        keyPoints: callStatus === "connected" ? ["Discussed project goals", "Confirmed next steps"] : undefined,
      },
      confidence: callStatus === "connected" ? 0.9 : 0.5,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Outbound call failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        phoneNumber,
        callStatus: "failed",
      },
      errorCode: "OUTBOUND_CALL_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Send email executor — returns structured email delivery result.
 */
export async function executeSendEmail(
  recipient: string,
  subject: string,
  body: string
): Promise<SendEmailOutput> {
  const startTime = Date.now();

  try {
    // Placeholder: in production, this calls SendGrid
    const deliveryStatus: "sent" | "queued" | "failed" | "bounced" = "sent";

    return {
      success: deliveryStatus === "sent",
      summary: `Email to ${recipient}: ${deliveryStatus}`,
      structured: {
        recipient,
        subject,
        bodyLength: body.length,
        deliveryStatus,
        messageId: deliveryStatus === "sent" ? `msg_${Date.now()}` : undefined,
      },
      confidence: deliveryStatus === "sent" ? 0.95 : 0.3,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Send email failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        recipient,
        subject,
        bodyLength: body.length,
        deliveryStatus: "failed",
        failureReason: error instanceof Error ? error.message : "Unknown error",
      },
      errorCode: "SEND_EMAIL_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Send SMS executor — returns structured SMS delivery result.
 */
export async function executeSendSms(
  recipient: string,
  message: string
): Promise<SendSmsOutput> {
  const startTime = Date.now();

  try {
    // Placeholder: in production, this calls Twilio
    const deliveryStatus: "sent" | "queued" | "failed" = "sent";
    const segmentCount = Math.ceil(message.length / 160);

    return {
      success: deliveryStatus === "sent",
      summary: `SMS to ${recipient}: ${deliveryStatus}`,
      structured: {
        recipient,
        messageLength: message.length,
        segmentCount,
        deliveryStatus,
        messageId: deliveryStatus === "sent" ? `sms_${Date.now()}` : undefined,
      },
      confidence: deliveryStatus === "sent" ? 0.95 : 0.3,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Send SMS failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        recipient,
        messageLength: message.length,
        segmentCount: 1,
        deliveryStatus: "failed",
        failureReason: error instanceof Error ? error.message : "Unknown error",
      },
      errorCode: "SEND_SMS_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Code generation executor — returns structured code generation result.
 */
export async function executeCodeGeneration(
  description: string,
  language: string
): Promise<CodeGenerationOutput> {
  const startTime = Date.now();

  try {
    const response = await invokeLLM({
      model: "gpt-5-mini",
      messages: [
        {
          role: "user",
          content: `Generate ${language} code for: ${description}`,
        },
      ],
    });

    // Estimate lines of code
    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const linesOfCode = responseText.split("\n").length;

    return {
      success: true,
      summary: `Generated ${linesOfCode} lines of ${language} code`,
      structured: {
        language,
        linesOfCode,
        filesGenerated: 1,
        testsPassing: 0,
        testsFailing: 0,
      },
      confidence: 0.8,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      summary: `Code generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      structured: {
        language,
        linesOfCode: 0,
        filesGenerated: 0,
        testsPassing: 0,
        testsFailing: 0,
      },
      errorCode: "CODE_GENERATION_FAILED",
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      executionTimeMs: Date.now() - startTime,
    };
  }
}
