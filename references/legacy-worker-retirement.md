# Legacy worker retirement controls

This service is retired and fail-closed by default. Database rows left over from
an older deployment cannot reactivate autonomous execution.

Re-enabling it requires all of the following:

1. A deployment operator explicitly sets `LEGACY_WORKER_ENABLED=true`.
2. The operator sets `LEGACY_WORKER_RISK_ACK=I_ACCEPT_LEGACY_WORKER_AUTONOMY_RISK`.
3. At least one verified owner identity is configured with `OWNER_OPEN_ID` or
   `OWNER_PHONE_E164`.
4. The verified owner explicitly resumes the worker after the deployment gate
   is open. Until then, the persisted kill switch remains active.

SMS control additionally requires `TWILIO_AUTH_TOKEN` and an exact canonical
HTTPS `TWILIO_SMS_WEBHOOK_URL`. Every inbound command must have a valid Twilio
signature and its `From` field must exactly match `OWNER_PHONE_E164`.
Authenticated Twilio message IDs are claimed atomically, so a captured signed
request cannot be replayed to resume the worker later.

`APPROVE` and `REJECT` must include an exact task ID. Plain commands no longer
select an ambiguous "most recent" task.

Removing either deployment opt-in variable immediately closes every runtime
gate, regardless of the stored database state. Restarting with retirement in
force also persists `kill_switch_active=true`, `system_status=retired`, and
clears prior owner authorization.
