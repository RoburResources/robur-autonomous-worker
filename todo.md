# Project TODO

- [x] Database schema: task_queue, execution_log, evaluations, goals, opportunities, system_config tables
- [x] Seed initial 4 business goals for Robur Resources
- [x] Seed default system_config with safety limits
- [x] Server: Task Generator cron handler (hourly) - LLM decomposes goals into tasks
- [x] Server: Task Executor cron handler (every 15 min) - picks highest priority PENDING task and executes
- [x] Server: Evaluator cron handler (daily 6pm AWST / 10:00 UTC) - reviews completed tasks, logs metrics
- [x] Server: Self-Improver cron handler (weekly Sunday) - analyzes data, adjusts weights
- [x] Server: Morning briefing cron (8am AWST / 00:00 UTC) - Retell AI call to user
- [x] Server: Evening briefing cron (5:30pm AWST / 09:30 UTC) - Retell AI call to user
- [x] Server: Retell AI integration - outbound call via POST /v2/create-phone-call
- [x] Server: Twilio SMS integration - send SMS and receive webhook
- [x] Server: SMS webhook handler for STOP kill switch and approval responses
- [x] Server: Safety controls (20 calls/day, 100 emails/day, $50 API/day, $500 approval gate)
- [x] Server: tRPC routers for dashboard (goals CRUD, task queue, execution log, opportunities, system config)
- [x] Admin Dashboard UI: Task Queue view
- [x] Admin Dashboard UI: Execution Log view
- [x] Admin Dashboard UI: Goals management (add/edit)
- [x] Admin Dashboard UI: Opportunities view
- [x] Admin Dashboard UI: System Health & Config
- [x] Admin Dashboard UI: Daily Metrics
- [x] Register all cron handlers in server/_core/index.ts
- [x] Configure secrets (RETELL_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)
- [x] Write vitest tests for core logic
- [x] Create heartbeat cron jobs after deployment (6 jobs registered and active)
- [x] Enforce daily API spend tracking against $50 cap in executor
- [x] Add full goal editing UI (edit text, priority, sub-goals for existing goals)
- [x] CRITICAL: All external human contact requires SMS approval first (7-day restriction until 2026-07-12)
- [x] Update task executor to gate outbound_call/send_email/send_sms with approval request
- [x] Store restriction rule in system_config with expiry date
- [x] Create task for Addison to call Michael back re: voice issues discussed

## Zero-Mistake Architecture Upgrades

- [x] Pre-mortem pre-flight: LLM generates top 3 failure modes before every task execution
- [x] Confidence-gated execution: tasks below 0.85 confidence auto-escalate to human review via SMS
- [x] Dual-agent verification: independent LLM-as-Judge verifies every completed task outcome
- [x] Dependency graph (DAG): replace flat priority queue with DAG-based execution engine
- [x] Formal output schema validation: JSON schema contracts validated before/after every action
- [x] Canary execution: synthetic data dry-run before real execution for external-contact tasks
- [x] DB schema: confidence_score, premortem_risks, verification_result, dag_dependencies stored in metadata JSON (no migration needed)
- [x] Tests: 24 new vitest tests for all 6 modules (46 total passing)
- [ ] Checkpoint and redeploy with all upgrades live
