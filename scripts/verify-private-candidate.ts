const rawBaseUrl = process.env.PRIVATE_CANDIDATE_URL || "";
const ownerSession = process.env.PRIVATE_OWNER_SESSION || "";
const expectInternalAutonomy =
  process.env.EXPECT_INTERNAL_AUTONOMY === "true";

if (!rawBaseUrl) {
  throw new Error(
    "PRIVATE_CANDIDATE_URL is required (use the SSH tunnel URL)"
  );
}

const baseUrl = new URL(rawBaseUrl);
if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)) {
  throw new Error(
    "Private verification is restricted to a localhost SSH tunnel"
  );
}

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

async function expectStatus(
  name: string,
  path: string,
  expectedStatus: number,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: "error",
    ...init,
  });
  checks.push({
    name,
    ok: response.status === expectedStatus,
    detail: `HTTP ${response.status}`,
  });
  return response;
}

const health = await expectStatus("health", "/api/health", 200);
const healthBody = (await health.json()) as {
  autonomousExecution?: boolean;
  legacyWorkerStatus?: string;
};
checks.push({
  name: expectInternalAutonomy
    ? "worker internal autonomy is active"
    : "worker remains paused",
  ok:
    healthBody.autonomousExecution === expectInternalAutonomy &&
    healthBody.legacyWorkerStatus ===
      (expectInternalAutonomy ? "enabled" : "retired_or_paused"),
  detail: `autonomousExecution=${String(healthBody.autonomousExecution)}`,
});
checks.push({
  name: "security headers",
  ok:
    health.headers.get("x-frame-options") === "DENY" &&
    health.headers.get("x-content-type-options") === "nosniff" &&
    Boolean(health.headers.get("content-security-policy")) &&
    Boolean(health.headers.get("ratelimit-limit")),
  detail: "required headers present",
});

await expectStatus(
  "anonymous goals are blocked",
  "/api/trpc/goals.list?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D",
  403
);
await expectStatus(
  "anonymous tasks are blocked",
  "/api/trpc/tasks.list?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22limit%22%3A10%7D%7D%7D",
  403
);
await expectStatus(
  "unsigned Retell task creation is blocked",
  "/api/webhooks/retell/create-task",
  403,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "read-only verification probe",
      action_type: "internal_research",
    }),
  }
);
await expectStatus(
  "unsigned voice routing is blocked",
  "/api/webhooks/voice/addison",
  403,
  {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "From=%2B61400000000&To=%2B61411111111",
  }
);

if (ownerSession) {
  const ownerCookie = `app_session_id=${ownerSession}`;
  await expectStatus(
    "owner health is readable",
    "/api/trpc/health.status?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D",
    200,
    { headers: { cookie: ownerCookie } }
  );
  await expectStatus(
    "owner config is readable",
    "/api/trpc/config.list?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D",
    200,
    { headers: { cookie: ownerCookie } }
  );
} else {
  checks.push({
    name: "owner session supplied",
    ok: false,
    detail: "PRIVATE_OWNER_SESSION is missing",
  });
}

const failures = checks.filter(check => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
}
if (failures.length > 0) {
  throw new Error(`${failures.length} private verification check(s) failed`);
}
