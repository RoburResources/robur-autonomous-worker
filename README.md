# Robur Autonomous Worker

An always-on, self-directing AI agent system that generates its own tasks, executes them using real-world tools (phone calls, SMS, email, web research), evaluates outcomes, and improves its own strategies over time. Built on a modern TypeScript stack with a live admin dashboard.

> **Platform note:** This project is built on the [Manus WebDev](https://manus.im) platform, which provides the LLM proxy, OAuth, database, cron scheduler (Heartbeat), and hosting infrastructure. The core autonomous worker logic is fully portable — see [Adapting to Other Platforms](#adapting-to-other-platforms) for migration notes.

---

## What It Does

The system runs a continuous autonomous loop across four phases:

```
Goals → Task Generator → Task Executor → Evaluator → Self-Improver → (repeat)
```

1. **Task Generator** (every 15 min): Queries active business goals, decomposes them into specific executable tasks using an LLM, scores by ROI and phase, and adds them to a priority queue.
2. **Task Executor** (every 15 min): Picks the highest-priority pending task and executes it — making outbound calls via Retell AI, sending SMS via Twilio, drafting emails, or conducting web research.
3. **Evaluator** (daily at configurable time): Reviews completed tasks, assesses outcomes using an LLM-as-judge pattern, logs success metrics, and triggers a voice briefing call.
4. **Self-Improver** (weekly): Analyses evaluation data, identifies winning vs losing strategies, and adjusts priority weights autonomously.

---

## Features

| Feature | Description |
|---|---|
| **Autonomous Task Generation** | LLM decomposes high-level goals into specific, executable tasks with ROI scoring and phase awareness |
| **Multi-Tool Execution** | Outbound calls (Retell AI), SMS (Twilio), email drafting, web research |
| **Voice Briefings** | Daily morning (8am) and evening (5:30pm) calls via AI voice agent |
| **Self-Evaluation** | LLM-as-judge pattern assesses task outcomes and logs lessons learned |
| **Self-Improvement** | Weekly analysis adjusts strategy weights based on real-world results |
| **Safety Controls** | Daily call/email/spend limits, $500+ approval gate, kill switch via SMS |
| **External Contact Gate** | Configurable restriction requiring SMS approval before contacting any real person |
| **Admin Dashboard** | Live task queue, execution log, goals management, system health, config editor |
| **SMS Webhook** | Inbound SMS handler for STOP/START/APPROVE/REJECT/STATUS commands |
| **Pre-flight Validation** | Checks credentials, dependencies, and limits before executing any task |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Admin Dashboard (React)                    │
│  Task Queue │ Execution Log │ Goals │ Opportunities │ Config  │
└─────────────────────┬───────────────────────────────────────┘
                      │ tRPC
┌─────────────────────▼───────────────────────────────────────┐
│                   Express Server (Node.js)                    │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │   Cron Jobs  │  │  tRPC Routes │  │   SMS Webhook      │  │
│  │  (Heartbeat) │  │  (Dashboard) │  │  /api/webhooks/sms │  │
│  └──────┬──────┘  └──────────────┘  └────────────────────┘  │
│         │                                                     │
│  ┌──────▼──────────────────────────────────────────────────┐ │
│  │              Autonomous Worker Core                      │ │
│  │  taskGenerator → taskExecutor → evaluator → selfImprover│ │
│  └──────┬──────────────────────────────────────────────────┘ │
│         │                                                     │
│  ┌──────▼──────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Retell AI  │  │    Twilio    │  │    LLM (via proxy) │  │
│  │  (Calls)    │  │  (SMS)       │  │  gpt-5-mini /      │  │
│  └─────────────┘  └──────────────┘  │  claude-sonnet-4-6 │  │
│                                      └────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                   MySQL Database (Drizzle ORM)                │
│  task_queue │ execution_log │ goals │ evaluations │ system_config │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| **Backend** | Node.js, Express 4, tRPC 11 |
| **Database** | MySQL (via Drizzle ORM) |
| **LLM** | OpenAI-compatible proxy (gpt-5-mini for generation, claude-sonnet-4-6 for evaluation) |
| **Voice** | Retell AI (outbound calls via `/v2/create-phone-call`) |
| **SMS** | Twilio REST API |
| **Cron** | Manus Heartbeat (HTTP-based cron, platform-managed) |
| **Auth** | Manus OAuth |
| **Hosting** | Manus WebDev (Cloud Run / Autoscale) |

---

## Prerequisites

Before deploying, you will need accounts and credentials for:

- **[Manus](https://manus.im)** — Platform for hosting, LLM access, OAuth, and cron scheduling
- **[Retell AI](https://retellai.com)** — AI voice agent platform for outbound calls
- **[Twilio](https://twilio.com)** — SMS sending and receiving
- A configured AI voice agent in Retell (the "Addison" agent for briefings and outbound tasks)

---

## Quick Start (Manus WebDev)

### 1. Fork and Clone

```bash
git clone https://github.com/RoburResources/robur-autonomous-worker.git
cd robur-autonomous-worker
pnpm install
```

### 2. Create a Manus WebDev Project

In your Manus workspace, create a new `web-db-user` project and connect it to this repository. The platform will inject all `BUILT_IN_*`, `DATABASE_URL`, `JWT_SECRET`, and OAuth environment variables automatically.

### 3. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables (see [Environment Variables](#environment-variables) for full list):

```env
RETELL_API_KEY=key_...
RETELL_AGENT_ID=agent_...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
USER_PHONE=+1...
```

### 4. Apply Database Schema

```bash
pnpm drizzle-kit generate
# Then apply the generated SQL via your database admin panel
```

Or use the Manus WebDev database tool to execute the SQL from `drizzle/0001_woozy_mockingbird.sql`.

### 5. Seed Initial Data

Edit `seed-handoff.mjs` to replace the Robur-specific business context with your own goals, operating principles, and config. Then run:

```bash
node seed-handoff.mjs
```

### 6. Deploy

Push to your connected repository. Manus WebDev will build and deploy automatically.

### 7. Register Cron Jobs

After the first deployment, register the 6 cron jobs using the Manus Heartbeat CLI:

```bash
# Task Generator — every 15 minutes
manus-heartbeat create --name task-generator --cron "0 */15 * * * *" --path /api/scheduled/task-generator

# Task Executor — every 15 minutes
manus-heartbeat create --name task-executor --cron "0 */15 * * * *" --path /api/scheduled/task-executor

# Evaluator — daily at 10:00 UTC (6pm AWST)
manus-heartbeat create --name evaluator --cron "0 0 10 * * *" --path /api/scheduled/evaluator

# Self-Improver — weekly Sunday at 14:00 UTC
manus-heartbeat create --name self-improver --cron "0 0 14 * * 0" --path /api/scheduled/self-improver

# Morning Briefing — daily at 00:00 UTC (8am AWST)
manus-heartbeat create --name morning-briefing --cron "0 0 0 * * *" --path /api/scheduled/morning-briefing

# Evening Briefing — daily at 09:30 UTC (5:30pm AWST)
manus-heartbeat create --name evening-briefing --cron "0 30 9 * * *" --path /api/scheduled/evening-briefing
```

> **Cron format:** 6-field with seconds — `sec min hour dom mon dow` in UTC.

### 8. Configure Twilio SMS Webhook

In your Twilio console, set the SMS webhook URL for your phone number to:

```
https://your-deployment-url.manus.space/api/webhooks/sms
```

This enables the STOP/START/APPROVE/REJECT/STATUS commands.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RETELL_API_KEY` | ✅ | Retell AI API key (`key_...`) |
| `RETELL_AGENT_ID` | ✅ | Retell AI agent ID for outbound calls (`agent_...`) |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio Account SID (`AC...`) |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | ✅ | Twilio phone number for SMS/calls (E.164 format, e.g. `+15550001234`) |
| `USER_PHONE` | ✅ | Owner's phone number for briefings and approval requests |
| `DATABASE_URL` | ✅ | MySQL connection string (auto-injected by Manus) |
| `JWT_SECRET` | ✅ | Session signing secret (auto-injected by Manus) |
| `BUILT_IN_FORGE_API_URL` | ✅ | Manus LLM proxy URL (auto-injected) |
| `BUILT_IN_FORGE_API_KEY` | ✅ | Manus LLM proxy key (auto-injected) |
| `VITE_APP_ID` | ✅ | Manus OAuth app ID (auto-injected) |
| `OAUTH_SERVER_URL` | ✅ | Manus OAuth server URL (auto-injected) |

---

## Cron Schedule

All times are configurable. The defaults are set for AWST (UTC+8):

| Job | Cron (UTC) | AWST Time | Purpose |
|---|---|---|---|
| `task-generator` | `0 */15 * * * *` | Every 15 min | Generate new tasks from goals |
| `task-executor` | `0 */15 * * * *` | Every 15 min | Execute highest-priority pending task |
| `evaluator` | `0 0 10 * * *` | 6:00pm daily | Evaluate completed tasks, log metrics |
| `self-improver` | `0 0 14 * * 0` | 10:00pm Sunday | Adjust strategy weights |
| `morning-briefing` | `0 0 0 * * *` | 8:00am daily | Addison calls owner with priorities |
| `evening-briefing` | `0 30 9 * * *` | 5:30pm daily | Addison calls owner with summary |

---

## Safety Controls

The system has multiple layers of protection against runaway behaviour:

| Control | Default | Config Key |
|---|---|---|
| Max outbound calls/day | 20 | `max_calls_per_day` |
| Max emails/day | 100 | `max_emails_per_day` |
| Max API spend/day | $50 USD | `max_api_spend_cents_per_day` |
| High-value approval gate | $500 AUD | `approval_threshold_cents` |
| External contact restriction | Configurable | `external_contact_approval_required` |
| Kill switch | SMS "STOP" | `kill_switch_active` |

### SMS Commands

Send these to your Twilio number to control the system:

| Command | Action |
|---|---|
| `STOP` | Immediately pause all autonomous operations |
| `START` | Resume operations |
| `APPROVE` | Approve the most recent pending approval task |
| `REJECT` | Reject the most recent pending approval task |
| `STATUS` | Get current system status |

---

## Database Schema

Seven tables power the autonomous loop:

| Table | Purpose |
|---|---|
| `task_queue` | Priority queue of all tasks (pending, in_progress, completed, failed, awaiting_approval) |
| `execution_log` | Full audit trail of every action taken |
| `evaluations` | LLM-assessed success/failure metrics per task |
| `goals` | High-level business objectives that drive task generation |
| `opportunities` | Detected market opportunities |
| `system_config` | All settings, limits, safety controls, and the system's "constitution" |
| `daily_metrics` | Aggregated daily stats (tasks, calls, emails, API spend) |

---

## Admin Dashboard

The dashboard at `/` provides full visibility and control:

- **Dashboard** — System status, daily metrics, pending tasks, recent activity
- **Task Queue** — Filter by status, view all tasks with priority scores and results
- **Execution Log** — Full audit trail with outcome, duration, and token cost
- **Goals** — Add, edit, and manage business objectives with sub-goals
- **Opportunities** — Detected opportunities with priority and status management
- **System Config** — Edit any configuration value live, including safety limits

---

## Seeding Your Own Business Context

The system's intelligence comes from the `system_config` table. The `seed-handoff.mjs` script shows how to populate it with:

- `constitution_identity` — Company details, contacts, agent IDs
- `constitution_principles` — Operating rules and evidence hierarchy
- `constitution_safety_rules` — Spending limits and operational boundaries
- `master_plan_roadmap` — Phase-by-phase strategic roadmap
- `top_20_strategies` — Ranked revenue strategies
- `known_failures_do_not_repeat` — Past failures to avoid

The task generator loads all of this context into every LLM call, making the system deeply aware of your business.

---

## Adapting to Other Platforms

The core autonomous logic (`server/autonomous/`, `server/integrations/`, `server/scheduled/`) is platform-agnostic. To run outside Manus:

| Manus Component | Replacement |
|---|---|
| `server/_core/heartbeat.ts` (cron) | Vercel Cron, GitHub Actions, node-cron, AWS EventBridge |
| `server/_core/llm.ts` (LLM proxy) | OpenAI SDK directly (`openai` npm package) |
| `server/_core/oauth.ts` (auth) | NextAuth, Clerk, Auth0 |
| `DATABASE_URL` (MySQL) | Any MySQL-compatible database (PlanetScale, Railway, Supabase) |
| Manus hosting | Vercel, Railway, Render, Fly.io |

---

## Running Tests

```bash
pnpm test
```

22 tests covering safety controls, SMS command parsing, priority scoring, weight clamping, Retell call params, and cron schedule calculations.

---

## Project Structure

```
server/
  autonomous/
    taskGenerator.ts    # LLM-powered task decomposition from goals
    taskExecutor.ts     # Multi-tool task execution with safety gates
    evaluator.ts        # LLM-as-judge outcome assessment
    selfImprover.ts     # Weekly strategy weight adjustment
    briefings.ts        # Morning/evening voice briefings
    preflightValidator.ts # Pre-execution credential/dependency checks
  integrations/
    retell.ts           # Retell AI outbound call integration
    twilio.ts           # Twilio SMS send/receive
  scheduled/
    handlers.ts         # Cron endpoint handlers
    smsWebhook.ts       # Inbound SMS command processor
  routers.ts            # tRPC API routes (dashboard)
  db.ts                 # Database query helpers
  _core/                # Manus WebDev platform internals (OAuth, LLM, cron)
client/src/
  pages/
    Home.tsx            # Dashboard overview
    TaskQueue.tsx       # Task queue browser
    ExecutionLog.tsx    # Audit trail
    Goals.tsx           # Goal management
    Opportunities.tsx   # Opportunity tracker
    SystemConfig.tsx    # Live config editor
drizzle/
  schema.ts             # Database schema (7 tables)
seed-handoff.mjs        # Business context seeding script
```

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you'd like to change.

---

## License

MIT
