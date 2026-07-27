/**
 * Voice Webhook Handler — Addison Inbound Calls
 *
 * When someone calls Addison's number (+61468061765), Twilio hits this endpoint.
 * We respond with TwiML that connects the call to Retell AI via SIP.
 *
 * Retell SIP endpoint: sip:{agent_id}@sip.retellai.com
 *
 * POST /api/webhooks/voice/addison
 */

import { Request, Response } from "express";

const ADDISON_AGENT_ID = "agent_7f02eb1896dd1e6deb38e54942";

export function addisonVoiceWebhookHandler(req: Request, res: Response) {
  const from = req.body?.From || "unknown";
  const to = req.body?.To || "unknown";

  console.log(`[Voice Webhook] Inbound call: ${from} → ${to}`);

  // TwiML to connect the inbound call to Retell AI via SIP
  // Retell handles the call with Addison's agent
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Sip>sip:${ADDISON_AGENT_ID}@sip.retellai.com;transport=tls</Sip>
  </Connect>
</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
}
