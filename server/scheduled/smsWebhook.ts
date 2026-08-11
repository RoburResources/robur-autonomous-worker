import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import {
  isVerifiedOwnerSmsRequest,
  parseInboundSMS,
} from "../integrations/twilio";
import { ownerSmsChannelCertified } from "../safety/smsChannelCertification";
import {
  drainInboundSmsInbox,
  EMPTY_TWIML,
  enqueueInboundSms,
  inboundSmsPayloadSchema,
} from "./smsWebhookInbox";

function xmlResponse(res: Response, status: number): void {
  res.type("text/xml").status(status).send(EMPTY_TWIML);
}

/**
 * Signed Twilio ingress. Authentication and one durable database commit are
 * the entire synchronous path. Internal recovery owns all slower work.
 */
export async function smsWebhookHandler(req: Request, res: Response) {
  if (!ownerSmsChannelCertified()) {
    xmlResponse(res, 404);
    return;
  }
  if (!isVerifiedOwnerSmsRequest(req)) {
    xmlResponse(res, 403);
    return;
  }

  const parsed = inboundSmsPayloadSchema.safeParse(parseInboundSMS(req.body));
  if (!parsed.success) {
    xmlResponse(res, 400);
    return;
  }
  const payloadDigest = createHash("sha256")
    .update(JSON.stringify(parsed.data), "utf8")
    .digest("hex");
  try {
    const enqueued = await enqueueInboundSms(parsed.data, payloadDigest);
    if (enqueued.disposition === "invalid") {
      xmlResponse(res, 400);
      return;
    }
    if (enqueued.disposition === "conflict") {
      xmlResponse(res, 409);
      return;
    }

    xmlResponse(res, 200);
    if (enqueued.disposition === "accepted") {
      void drainInboundSmsInbox().catch(error => {
        console.error(
          "[SMS Webhook] Immediate inbox drain failed:",
          error instanceof Error ? error.message : "unknown error"
        );
      });
    }
  } catch (error) {
    console.error(
      "[SMS Webhook] Durable enqueue failed:",
      error instanceof Error ? error.message : "unknown error"
    );
    xmlResponse(res, 503);
  }
}
