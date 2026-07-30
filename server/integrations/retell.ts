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
  const agentId = process.env.RETELL_AGENT_ID || "";
  const agentVersion = Number(process.env.RETELL_AGENT_VERSION);
  const userPhone = process.env.USER_PHONE || "";
  const fromNumber = getTwilioFromNumber();
  if (
    !agentId ||
    !Number.isInteger(agentVersion) ||
    !userPhone ||
    !fromNumber
  ) {
    throw new Error(
      "RETELL_AGENT_ID, RETELL_AGENT_VERSION, TWILIO_PHONE_NUMBER, and USER_PHONE must be configured for briefing calls"
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
