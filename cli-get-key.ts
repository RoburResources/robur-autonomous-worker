import { Composio } from "@composio/core";

// Use CLI session to get an API key
// This creates a session that can be used to authenticate
const composio = new Composio({ apiKey: "placeholder" });
const client = composio.getClient() as any;

try {
  // Create a CLI session - this returns a session with a code
  const session = await client.cli.createSession({});
  console.log("CLI Session:", JSON.stringify(session, null, 2));
} catch (e: any) {
  console.log("Error creating session:", e.message);
  console.log("Status:", e.status);
  if (e.body) console.log("Body:", JSON.stringify(e.body, null, 2));
}
