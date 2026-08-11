/**
 * Retell AI Integration
 * Uses POST /v2/create-phone-call endpoint for outbound calls
 */
import { isPrivateCandidateInternalOnly } from "../safety/privateCandidatePolicy";

const RETELL_API_URL = "https://api.retellai.com";

function getRetellApiKey(): string {
  return process.env.RETELL_API_KEY || "";
}

function getTwilioFromNumber(): string {
  return process.env.TWILIO_PHONE_NUMBER || "";
}

export interface OutboundCallParams {
  agentId: string;
  agentVersion: number;
  toNumber: string;
  fromNumber: string;
  approvedScript: string;
  metadata?: Record<string, any>;
}

export interface CallResult {
  callId: string;
  status: string;
  agentId: string;
  agentVersion: number;
  fromNumber: string;
  toNumber: string;
}

export type RetellCallStatus =
  | "registered"
  | "not_connected"
  | "ongoing"
  | "ended"
  | "error";

export interface RetellCallDetails {
  callId: string;
  agentId: string;
  agentVersion: number;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  callStatus: RetellCallStatus;
  disconnectionReason: string;
  externalDispatchId?: string;
  callSuccessful?: boolean;
  callSummary: string;
  userSentiment: string;
}

const RETELL_GET_CALL_TIMEOUT_MS = 10_000;
const RETELL_GET_CALL_MAX_RESPONSE_BYTES = 256 * 1024;
const RETELL_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const RETELL_AGENT_ID_PATTERN = /^agent_[A-Za-z0-9_-]{8,190}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EXTERNAL_DISPATCH_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETELL_CALL_STATUSES = new Set<RetellCallStatus>([
  "registered",
  "not_connected",
  "ongoing",
  "ended",
  "error",
]);
const RETELL_DISCONNECTION_REASONS = new Set([
  "user_hangup",
  "agent_hangup",
  "call_transfer",
  "voicemail_reached",
  "ivr_reached",
  "inactivity",
  "max_duration_reached",
  "concurrency_limit_reached",
  "no_concurrency_fallback",
  "no_valid_payment",
  "scam_detected",
  "dial_busy",
  "dial_failed",
  "dial_no_answer",
  "invalid_destination",
  "telephony_provider_permission_denied",
  "telephony_provider_unavailable",
  "sip_routing_error",
  "marked_as_spam",
  "user_declined",
  "error_llm_websocket_open",
  "error_llm_websocket_lost_connection",
  "error_llm_websocket_runtime",
  "error_llm_websocket_corrupt_payload",
  "error_no_audio_received",
  "error_asr",
  "error_retell",
  "error_unknown",
  "error_user_not_joined",
  "registered_call_timeout",
  "transfer_bridged",
  "transfer_cancelled",
  "manual_stopped",
  "call_take_over",
]);

class RetellGetCallError extends Error {}

function invalidRetellGetCallResponse(): never {
  throw new RetellGetCallError(
    "Retell Get Call returned an invalid response"
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredBoundedString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    return invalidRetellGetCallResponse();
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number
): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    return invalidRetellGetCallResponse();
  }
  return value;
}

function parseRetellGetCallResponse(
  value: unknown,
  expectedCallId: string
): RetellCallDetails {
  if (!isJsonObject(value)) return invalidRetellGetCallResponse();

  const callId = requiredBoundedString(
    value.call_id,
    160,
    RETELL_CALL_ID_PATTERN
  );
  if (callId !== expectedCallId) return invalidRetellGetCallResponse();

  const agentId = requiredBoundedString(
    value.agent_id,
    200,
    RETELL_AGENT_ID_PATTERN
  );
  const agentVersion = value.agent_version;
  if (
    !Number.isSafeInteger(agentVersion) ||
    Number(agentVersion) < 0 ||
    Number(agentVersion) > 1_000_000
  ) {
    return invalidRetellGetCallResponse();
  }

  const direction = value.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    return invalidRetellGetCallResponse();
  }
  const fromNumber = requiredBoundedString(value.from_number, 16, E164_PATTERN);
  const toNumber = requiredBoundedString(value.to_number, 16, E164_PATTERN);

  const callStatus = value.call_status;
  if (
    typeof callStatus !== "string" ||
    !RETELL_CALL_STATUSES.has(callStatus as RetellCallStatus)
  ) {
    return invalidRetellGetCallResponse();
  }

  let disconnectionReason = "";
  if (
    value.disconnection_reason !== undefined &&
    value.disconnection_reason !== null
  ) {
    if (
      typeof value.disconnection_reason !== "string" ||
      !RETELL_DISCONNECTION_REASONS.has(value.disconnection_reason)
    ) {
      return invalidRetellGetCallResponse();
    }
    disconnectionReason = value.disconnection_reason;
  }

  let externalDispatchId: string | undefined;
  if (value.metadata !== undefined && value.metadata !== null) {
    if (!isJsonObject(value.metadata)) {
      return invalidRetellGetCallResponse();
    }
    const dispatchId = value.metadata.external_dispatch_id;
    if (dispatchId !== undefined && dispatchId !== null) {
      if (
        typeof dispatchId !== "string" ||
        !EXTERNAL_DISPATCH_ID_PATTERN.test(dispatchId)
      ) {
        return invalidRetellGetCallResponse();
      }
      externalDispatchId = dispatchId.toLowerCase();
    }
  }

  let callSuccessful: boolean | undefined;
  let callSummary = "";
  let userSentiment = "";
  if (value.call_analysis !== undefined && value.call_analysis !== null) {
    if (!isJsonObject(value.call_analysis)) {
      return invalidRetellGetCallResponse();
    }
    const successful = value.call_analysis.call_successful;
    if (successful !== undefined && successful !== null) {
      if (typeof successful !== "boolean") {
        return invalidRetellGetCallResponse();
      }
      callSuccessful = successful;
    }
    callSummary = optionalBoundedString(
      value.call_analysis.call_summary,
      20_000
    );
    userSentiment = optionalBoundedString(
      value.call_analysis.user_sentiment,
      64
    );
  }

  return {
    callId,
    agentId,
    agentVersion: Number(agentVersion),
    direction,
    fromNumber,
    toNumber,
    callStatus: callStatus as RetellCallStatus,
    disconnectionReason,
    ...(externalDispatchId ? { externalDispatchId } : {}),
    ...(callSuccessful === undefined ? {} : { callSuccessful }),
    callSummary,
    userSentiment,
  };
}

async function readBoundedRetellResponse(response: Response): Promise<string> {
  const cancelInvalidResponse = async (): Promise<never> => {
    await response.body?.cancel().catch(() => undefined);
    return invalidRetellGetCallResponse();
  };
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return cancelInvalidResponse();
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > RETELL_GET_CALL_MAX_RESPONSE_BYTES
    ) {
      return cancelInvalidResponse();
    }
  }

  if (!response.body) return invalidRetellGetCallResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > RETELL_GET_CALL_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return invalidRetellGetCallResponse();
    }
    chunks.push(value);
  }
  if (totalBytes === 0) return invalidRetellGetCallResponse();
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Retrieve one Retell call for read-only terminal-outcome reconciliation.
 * The response is accepted only when its provider identity and bounded fields
 * match the documented phone-call contract.
 */
export async function getRetellCall(
  callId: string
): Promise<RetellCallDetails> {
  if (!RETELL_CALL_ID_PATTERN.test(callId)) {
    throw new Error("Invalid Retell call ID");
  }
  const apiKey = getRetellApiKey();
  if (!apiKey) {
    throw new Error("RETELL_API_KEY not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    RETELL_GET_CALL_TIMEOUT_MS
  );
  timeout.unref();
  try {
    const response = await fetch(
      `${RETELL_API_URL}/v2/get-call/${encodeURIComponent(callId)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      throw new RetellGetCallError(
        `Retell Get Call failed with HTTP ${response.status}`
      );
    }

    const body = await readBoundedRetellResponse(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new RetellGetCallError(
        "Retell Get Call returned invalid JSON"
      );
    }
    return parseRetellGetCallResponse(parsed, callId);
  } catch (error) {
    if (error instanceof RetellGetCallError) throw error;
    if (
      controller.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw new Error("Retell Get Call request timed out");
    }
    throw new Error("Retell Get Call request failed");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an outbound call via Retell AI
 * Uses POST /v2/create-phone-call (NOT Twilio SIP dial)
 */
export async function makeOutboundCall(params: OutboundCallParams): Promise<CallResult> {
  if (isPrivateCandidateInternalOnly()) {
    throw new Error("Outbound call blocked by private-candidate containment");
  }

  const apiKey = getRetellApiKey();
  if (!apiKey) {
    throw new Error("RETELL_API_KEY not configured");
  }

  const fromNumber = params.fromNumber;
  if (!/^\+[1-9]\d{7,14}$/.test(fromNumber)) {
    throw new Error("No from_number configured (TWILIO_PHONE_NUMBER)");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(params.toNumber)) {
    throw new Error("Invalid outbound Retell to_number");
  }
  if (!/^agent_[A-Za-z0-9_-]{8,190}$/.test(params.agentId)) {
    throw new Error("Invalid pinned Retell agent ID");
  }
  if (
    !Number.isInteger(params.agentVersion) ||
    params.agentVersion < 0 ||
    params.agentVersion > 1_000_000
  ) {
    throw new Error("Invalid pinned Retell agent version");
  }
  if (
    typeof params.approvedScript !== "string" ||
    params.approvedScript.length < 1 ||
    params.approvedScript.length > 4_000
  ) {
    throw new Error("Invalid approved Retell script");
  }

  const response = await fetch(`${RETELL_API_URL}/v2/create-phone-call`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to_number: params.toNumber,
      from_number: fromNumber,
      override_agent_id: params.agentId,
      override_agent_version: params.agentVersion,
      retell_llm_dynamic_variables: {
        approved_script: params.approvedScript,
      },
      metadata: params.metadata || {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Retell API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const callId =
    typeof data.call_id === "string" ? data.call_id.trim() : "";
  if (!callId) {
    throw new Error(
      "Retell accepted the request without call_id; outcome requires reconciliation"
    );
  }
  const returnedAgentId =
    typeof data.agent_id === "string" ? data.agent_id.trim() : "";
  const returnedAgentVersion = data.agent_version;
  const returnedFrom =
    typeof data.from_number === "string" ? data.from_number.trim() : "";
  const returnedTo =
    typeof data.to_number === "string" ? data.to_number.trim() : "";
  if (
    returnedAgentId !== params.agentId ||
    returnedAgentVersion !== params.agentVersion ||
    returnedFrom !== fromNumber ||
    returnedTo !== params.toNumber ||
    data.direction !== "outbound"
  ) {
    throw new Error(
      "Retell accepted the request with an unexpected agent, version, sender, recipient, or direction; outcome requires reconciliation"
    );
  }
  return {
    callId,
    status: data.call_status || data.status || "registered",
    agentId: returnedAgentId,
    agentVersion: returnedAgentVersion,
    fromNumber: returnedFrom,
    toNumber: returnedTo,
  };
}

/**
 * Make a briefing call to the user via Addison
 */
export async function makeBriefingCall(briefingType: "morning" | "evening", briefingContent: string): Promise<CallResult> {
  const agentId = process.env.RETELL_EXECUTIVE_ASSISTANT_AGENT_ID || "";
  const agentVersion = Number(
    process.env.RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION
  );
  const userPhone =
    process.env.OWNER_PHONE_E164 || process.env.USER_PHONE || "";
  const fromNumber = getTwilioFromNumber();
  if (
    !agentId ||
    !Number.isInteger(agentVersion) ||
    !userPhone ||
    !fromNumber
  ) {
    throw new Error(
      "RETELL_EXECUTIVE_ASSISTANT_AGENT_ID, RETELL_EXECUTIVE_ASSISTANT_AGENT_VERSION, TWILIO_PHONE_NUMBER, and OWNER_PHONE_E164 must be configured for briefing calls"
    );
  }

  return makeOutboundCall({
    agentId,
    agentVersion,
    toNumber: userPhone,
    fromNumber,
    approvedScript: briefingContent,
    metadata: {
      briefing_type: briefingType,
      timestamp: new Date().toISOString(),
    },
  });
}
