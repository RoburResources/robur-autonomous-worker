# Private Candidate Operations

This runbook applies only to the isolated Railway candidate.

## Authoritative target

- Project: `robur-autonomous-worker`
- Project ID: `c27db74c-5419-4c45-a403-1fafeba56829`
- Environment: `private-candidate`
- Environment ID: `894781b5-86ed-4df3-9f42-1393320bd857`
- Application service ID: `31c607a8-09b6-40b1-955a-f952571c3e0d`
- MySQL service ID: `935f0801-a45c-4da0-9384-7afe2c8923a2`
- Candidate branch: `codex/private-railway-auth`

Compare these opaque IDs byte-for-byte before every Railway mutation. The
empty Railway `production` environment is not a deployment target.

## Required containment state

The candidate may run internal autonomous work only when all of these remain
true:

- `PRIVATE_CANDIDATE_INTERNAL_ONLY=true`
- `PRIVATE_CANDIDATE_INTERNAL_AUTONOMY=true`
- only `web_research` and `data_entry` tasks are executable
- no public or custom domain
- no Railway or provider cron schedules
- no provider webhooks pointing to this service
- no production, Rachel, payment, call, SMS, or email changes
- owner-only reads and writes

The in-process scheduler may be activated with:

- `kill_switch_active=false`
- `system_status=active`
- `legacy_worker_owner_authorized=true`
- `autonomousExecution=true`

This activation authorizes internal LLM reasoning, task generation, internal
research/data-entry execution, evaluation, and self-improvement only. Any task
whose action type could call, SMS, email, or otherwise communicate externally
is moved to `awaiting_approval` without sending a notification.

Use the existing canonical Railway service URL with the owner-only session:

- `https://robur-autonomous-worker-private-candidate.up.railway.app`

Do not provision another domain. Anonymous and non-owner reads and writes must
remain rejected. The short-lived owner bootstrap may establish the normal
owner session, but its one-time token must never be logged or persisted.

## Verification

Run the committed build verification:

```powershell
npx.cmd --yes pnpm@10.4.1 verify
```

For command-line verification, open a localhost SSH tunnel and supply a
short-lived owner session only in the process environment:

```powershell
$env:PRIVATE_CANDIDATE_URL='http://127.0.0.1:18080'
$env:PRIVATE_OWNER_SESSION='<ephemeral signed session>'
$env:EXPECT_INTERNAL_AUTONOMY='true'
npm.cmd run verify:private
Remove-Item Env:PRIVATE_OWNER_SESSION
Remove-Item Env:EXPECT_INTERNAL_AUTONOMY
```

The verifier is deliberately restricted to localhost. It performs read-only
owner checks plus rejected unauthenticated probes. It never changes the worker
state or creates a task.

The execution adapter remains WSL2-only. The Windows-native route is rejected
and must not be represented as certified. The authoritative adapter evidence is
in `../private/codex-adapter/CERTIFICATION.md`.

## Security controls

- All sensitive tRPC procedures require the configured admin owner.
- Storage redirects require the configured admin owner.
- Scheduled routes require an authenticated cron identity and an open runtime
  gate.
- SMS and voice routes fail closed unless the canonical Twilio webhook URL,
  signature, owner number, and destination number all match.
- Retell routes fail closed without the configured Retell credential.
- Unsafe cross-site tRPC mutations are rejected.
- API, OAuth, webhook, and storage paths have bounded in-memory request limits.
- Request bodies are capped at 1 MB.
- Browser security headers are emitted on every response.
- The production dependency audit must report no known vulnerabilities.

## Monitoring and incident response

Railway health is `/api/health`; while the contained internal scheduler is
active it must report `legacyWorkerStatus=enabled` and
`autonomousExecution=true`.
Inspect Railway deployment status and logs after every mutation. External alert
delivery is not configured because sending SMS, email, calls, or third-party
notifications is a protected external communication.

If containment changes unexpectedly:

1. Restore `kill_switch_active=true` and `system_status=paused`.
2. Verify `/api/health` reports autonomous execution as false.
3. Stop only the exact in-scope trigger after identifying it.
4. Confirm no new external-effect task, execution, call, SMS, or email row.
5. Preserve the deployment ID and logs before further changes.

## Backup and disaster recovery

The MySQL volume is persistent, but persistence is not an independent backup.
The isolated logical backup/restore drill passed on 30 July 2026:

- evidence: `../MYSQL_BACKUP_RESTORE_DRILL_2026-07-30.md`
- evidence SHA-256:
  `7f25e287f24671557919be31ae078525c54a0ae62098c1ed724e6cc214e2643f`
- schema hashes matched
- all nine table counts and checksums matched
- the app remained connected to the source database
- production remained empty
- the temporary restore environment was removed after proof

Repeat the drill before production if the schema, database engine, backup
method, or release data materially changes.

## Rollback

Before deployment, record the current successful deployment ID and image
digest. If the new deployment fails verification, redeploy the last verified
candidate and repeat the containment checks. A timeout or closed connection is
an unknown outcome; inspect Railway deployment history before retrying.
