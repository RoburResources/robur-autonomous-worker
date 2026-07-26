/**
 * Retell AI Integration
 * Uses POST /v2/create-phone-call endpoint for outbound calls
 */

const RETELL_API_URL = "https://api.retellai.com";

function getRetellApiKey(): string {
  return process.env.RETELL_API_KEY || "";
}

function getTwilioFromNumber(): string {
  return process.env.TWILIO_PHONE_NUMBER || "";
}

export interface OutboundCallParams {
  agentId: string;
  toNumber: string;
  fromNumber?: string;
  metadata?: Record<string, any>;
}

export interface CallResult {
  callId: string;
  status: string;
}

/**
 * Make an outbound call via Retell AI
 * Uses POST /v2/create-phone-call (NOT Twilio SIP dial)
 */
export async function makeOutboundCall(params: OutboundCallParams): Promise<CallResult> {
  const apiKey = getRetellApiKey();
  if (!apiKey) {
    throw new Error("RETELL_API_KEY not configured");
  }

  const fromNumber = params.fromNumber || getTwilioFromNumber();
  if (!fromNumber) {
    throw new Error("No from_number configured (TWILIO_PHONE_NUMBER)");
  }

  const response = await fetch(`${RETELL_API_URL}/v2/create-phone-call`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: params.agentId,
      to_number: params.toNumber,
      from_number: fromNumber,
      metadata: params.metadata || {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Retell API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    callId: data.call_id || data.id || "unknown",
    status: data.status || "initiated",
  };
}

/**
 * Make a briefing call to the user via Addison
 */
export async function makeBriefingCall(briefingType: "morning" | "evening", briefingContent: string): Promise<CallResult> {
  const agentId = process.env.RETELL_AGENT_ID || "";
  const userPhone = process.env.USER_PHONE || "";
  if (!agentId || !userPhone) {
    throw new Error("RETELL_AGENT_ID and USER_PHONE must be configured for briefing calls");
  }

  return makeOutboundCall({
    agentId,
    toNumber: userPhone,
    metadata: {
      briefing_type: briefingType,
      briefing_content: briefingContent,
      timestamp: new Date().toISOString(),
    },
  });
}
