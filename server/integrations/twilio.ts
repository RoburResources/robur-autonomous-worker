/**
 * Twilio SMS Integration
 * Handles outbound SMS and inbound webhook processing
 */

function getTwilioCredentials() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  };
}

/**
 * Send an SMS via Twilio REST API
 */
export async function sendSMS(to: string, body: string): Promise<{ sid: string; status: string }> {
  const { accountSid, authToken, phoneNumber } = getTwilioCredentials();

  if (!accountSid || !authToken || !phoneNumber) {
    console.warn("[Twilio] Credentials not configured, SMS not sent:", { to, body: body.substring(0, 50) });
    return { sid: "not_configured", status: "skipped" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: phoneNumber,
      Body: body,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio SMS error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    sid: data.sid || "unknown",
    status: data.status || "sent",
  };
}

/**
 * Validate Twilio webhook signature (basic validation)
 */
export function validateTwilioWebhook(req: any): boolean {
  // In production, validate X-Twilio-Signature header
  // For now, check that required fields are present
  const body = req.body;
  return !!(body && (body.Body !== undefined || body.From));
}

/**
 * Parse inbound SMS from Twilio webhook
 */
export function parseInboundSMS(body: any): { from: string; message: string; messageSid: string } {
  return {
    from: body.From || "",
    message: (body.Body || "").trim(),
    messageSid: body.MessageSid || "",
  };
}
