import { validateTwilioRetryConfiguration } from "../integrations/twilio";

/**
 * One fail-closed release gate for owner SMS ingress. A source flag alone is
 * insufficient: exact identities, signing material, and bounded provider
 * retry overrides must all be present. Emergency STOP is the only SMS command
 * permitted to change the runtime gate; resume requires the owner dashboard.
 */
export function ownerSmsChannelCertified(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const authToken = env.TWILIO_AUTH_TOKEN || "";
  return (
    env.OWNER_SMS_COMMAND_CHANNEL_CERTIFIED === "true" &&
    /^AC[a-fA-F0-9]{32}$/.test(env.TWILIO_ACCOUNT_SID || "") &&
    /^\+[1-9]\d{7,14}$/.test(env.TWILIO_PHONE_NUMBER || "") &&
    /^\+[1-9]\d{7,14}$/.test(env.OWNER_PHONE_E164 || "") &&
    /^[a-fA-F0-9]{32}$/.test(authToken) &&
    validateTwilioRetryConfiguration(env.TWILIO_SMS_WEBHOOK_URL || "")
  );
}
