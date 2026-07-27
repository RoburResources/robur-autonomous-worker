/**
 * Structured action output types — formal contracts for every action type.
 * All action executors MUST return a structured object matching these types.
 * The schema validator enforces these contracts before/after execution.
 */

export type ActionType =
  | "web_research"
  | "data_entry"
  | "outbound_call"
  | "send_email"
  | "send_sms"
  | "code_generation"
  | "file_processing";

/**
 * Base structured output — all actions return this shape.
 */
export interface StructuredActionOutput {
  success: boolean;
  summary: string; // Human-readable summary for logs
  structured: Record<string, unknown>; // Action-specific structured data
  confidence?: number; // 0–1, how confident the executor is in this result
  executionTimeMs?: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Web research output — findings from web search/scraping.
 */
export interface WebResearchOutput extends StructuredActionOutput {
  structured: {
    findings: string[]; // Array of key findings (min 2)
    sourcesConsulted: string[]; // Where the data came from (min 1)
    dataPoints: number; // Quantity of data collected (min 1)
    confidence: number; // 0–1, data quality confidence
    nextActions?: string[]; // Recommended next steps
    rawData?: Record<string, unknown>; // Optional raw data for verification
  };
}

/**
 * Data entry output — records created/updated in a system.
 */
export interface DataEntryOutput extends StructuredActionOutput {
  structured: {
    recordsCreated: number;
    recordsUpdated: number;
    recordsSkipped: number;
    validationErrors?: string[];
    successRate: number; // 0–1
    sampleRecords?: Record<string, unknown>[]; // First 3 records for verification
  };
}

/**
 * Outbound call output — call attempt result.
 */
export interface OutboundCallOutput extends StructuredActionOutput {
  structured: {
    phoneNumber: string;
    callDuration?: number; // seconds
    callStatus: "connected" | "voicemail" | "busy" | "no_answer" | "failed";
    keyPoints?: string[]; // What was discussed
    nextSteps?: string[];
    recordingUrl?: string; // Optional call recording
  };
}

/**
 * Send email output — email delivery result.
 */
export interface SendEmailOutput extends StructuredActionOutput {
  structured: {
    recipient: string;
    subject: string;
    bodyLength: number;
    deliveryStatus: "sent" | "queued" | "failed" | "bounced";
    messageId?: string;
    failureReason?: string;
  };
}

/**
 * Send SMS output — SMS delivery result.
 */
export interface SendSmsOutput extends StructuredActionOutput {
  structured: {
    recipient: string;
    messageLength: number;
    segmentCount: number; // SMS is 160 chars per segment
    deliveryStatus: "sent" | "queued" | "failed";
    messageId?: string;
    failureReason?: string;
  };
}

/**
 * Code generation output — code written/modified.
 */
export interface CodeGenerationOutput extends StructuredActionOutput {
  structured: {
    language: string;
    linesOfCode: number;
    filesGenerated: number;
    testsPassing: number;
    testsFailing: number;
    codeUrl?: string; // Link to generated code
    compilationErrors?: string[];
  };
}

/**
 * File processing output — files processed/transformed.
 */
export interface FileProcessingOutput extends StructuredActionOutput {
  structured: {
    filesProcessed: number;
    filesSuccessful: number;
    filesFailed: number;
    outputFormat: string;
    outputSize?: number; // bytes
    processingTimeMs: number;
    errors?: string[];
  };
}

/**
 * Union type for all possible structured outputs.
 */
export type StructuredOutput =
  | WebResearchOutput
  | DataEntryOutput
  | OutboundCallOutput
  | SendEmailOutput
  | SendSmsOutput
  | CodeGenerationOutput
  | FileProcessingOutput;

/**
 * JSON Schema definitions for validation.
 */
export const ACTION_SCHEMAS: Record<ActionType, Record<string, unknown>> = {
  web_research: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        description: "Array of key findings (minimum 2)",
      },
      sourcesConsulted: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Sources where data came from",
      },
      dataPoints: {
        type: "number",
        minimum: 1,
        description: "Quantity of data collected",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Data quality confidence (0–1)",
      },
    },
    required: ["findings", "sourcesConsulted", "dataPoints", "confidence"],
  },

  data_entry: {
    type: "object",
    properties: {
      recordsCreated: { type: "number", minimum: 0 },
      recordsUpdated: { type: "number", minimum: 0 },
      recordsSkipped: { type: "number", minimum: 0 },
      successRate: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Fraction of records that succeeded",
      },
    },
    required: ["recordsCreated", "recordsUpdated", "recordsSkipped", "successRate"],
  },

  outbound_call: {
    type: "object",
    properties: {
      phoneNumber: { type: "string", pattern: "^\\+?[0-9]{10,15}$" },
      callStatus: {
        type: "string",
        enum: ["connected", "voicemail", "busy", "no_answer", "failed"],
      },
      callDuration: { type: "number", minimum: 0 },
    },
    required: ["phoneNumber", "callStatus"],
  },

  send_email: {
    type: "object",
    properties: {
      recipient: { type: "string", format: "email" },
      subject: { type: "string", minLength: 5 },
      bodyLength: { type: "number", minimum: 20 },
      deliveryStatus: {
        type: "string",
        enum: ["sent", "queued", "failed", "bounced"],
      },
    },
    required: ["recipient", "subject", "bodyLength", "deliveryStatus"],
  },

  send_sms: {
    type: "object",
    properties: {
      recipient: { type: "string", pattern: "^\\+?[0-9]{10,15}$" },
      messageLength: { type: "number", minimum: 1, maximum: 1600 },
      segmentCount: { type: "number", minimum: 1 },
      deliveryStatus: {
        type: "string",
        enum: ["sent", "queued", "failed"],
      },
    },
    required: ["recipient", "messageLength", "segmentCount", "deliveryStatus"],
  },

  code_generation: {
    type: "object",
    properties: {
      language: { type: "string" },
      linesOfCode: { type: "number", minimum: 1 },
      filesGenerated: { type: "number", minimum: 1 },
      testsPassing: { type: "number", minimum: 0 },
      testsFailing: { type: "number", minimum: 0 },
    },
    required: ["language", "linesOfCode", "filesGenerated"],
  },

  file_processing: {
    type: "object",
    properties: {
      filesProcessed: { type: "number", minimum: 1 },
      filesSuccessful: { type: "number", minimum: 0 },
      filesFailed: { type: "number", minimum: 0 },
      outputFormat: { type: "string" },
      processingTimeMs: { type: "number", minimum: 0 },
    },
    required: ["filesProcessed", "filesSuccessful", "filesFailed", "outputFormat"],
  },
};
