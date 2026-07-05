/**
 * Seed the Master Handoff Document into the autonomous worker database.
 * Run with: node seed-handoff.mjs
 * 
 * This script:
 * 1. Stores the constitution and operating principles in system_config
 * 2. Adds roadmap goals to the goals table
 * 3. Seeds Day 1-2 actionable tasks into task_queue
 */

import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import "dotenv/config";

// We'll use raw SQL via the drizzle connection
const db = drizzle(process.env.DATABASE_URL);

// Helper to insert system_config entries
async function setConfig(key, value, description) {
  await db.execute(sql`INSERT INTO system_config (configKey, configValue, description) VALUES (${key}, ${value}, ${description}) ON DUPLICATE KEY UPDATE configValue = VALUES(configValue), description = VALUES(description)`);
}

// Helper to insert goals
async function insertGoal(goalText, priority, subGoals, status = "active") {
  await db.execute(sql`INSERT INTO goals (goalText, status, priority, subGoals) VALUES (${goalText}, ${status}, ${priority}, ${JSON.stringify(subGoals)})`);
}

// Helper to insert tasks
async function insertTask(description, actionType, priorityScore, goalId = null, estimatedValue = "0") {
  await db.execute(sql`INSERT INTO task_queue (description, actionType, priorityScore, goalId, source, status, estimatedValue) VALUES (${description}, ${actionType}, ${priorityScore}, ${goalId}, 'manual_seed', 'pending', ${estimatedValue})`);
}

async function main() {
  console.log("🧠 Seeding Master Handoff Document into database...\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. STORE CONSTITUTION AND OPERATING PRINCIPLES IN SYSTEM_CONFIG
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("📜 Storing constitution and operating principles...");

  await setConfig("constitution_identity", JSON.stringify({
    company_name: "Robur Resources",
    abn: "62 699 058 001",
    address: "1/9 The Esplanade, Elizabeth Quay, Perth WA 6000",
    operations_base: "Neerabup, Perth, Western Australia",
    owner: "Michael T (Tarz)",
    owner_phone: "+61 495 007 200",
    owner_email_business: "michael@robur.com.au",
    owner_email_personal: "Michael.primarymail@gmail.com",
    addison_phone: "+61 468 061 765",
    addison_agent_id: "agent_7f02eb1896dd1e6deb38e54942",
    rachel_phone: "+61 485 000 131",
    rachel_agent_id: "agent_5fdd6a1e4df124f0306ab4af10",
    rachel_public_number: "1300 005 550",
    legacy_name: "Metal X Renewables (NEVER USE)",
    brand_colors: { gold: "#FFC400", charcoal: "#22262B" }
  }), "Core identity: company details, contacts, agent IDs, brand");

  await setConfig("constitution_principles", JSON.stringify({
    zero_unnecessary_questions: "Never ask Michael questions that can be answered independently. Exhaust all resources first.",
    absolute_autonomy: "Work fully autonomously. Persist through blockers. Only report failure after 3 distinct attempts.",
    evidence_first: "Measured > Estimated. Verified > Assumed. Never fabricate data.",
    revenue_focus: "Every action must have clear outcome related to revenue generation or operational efficiency.",
    quality_standard: "Finished goods prime grade - professional, complete, build-ready without guesswork.",
    communication_style: "Concise. One question at a time. Dot points. Layman's terms. Don't overwhelm.",
    evidence_hierarchy: [
      "1. Primary (Verified): Bank statements, signed contracts, weighbridge tickets, official docs",
      "2. Secondary (Supplied): Emails, invoices, RCTIs, messages with attachments",
      "3. Tertiary (System): CRM records, system logs, database entries",
      "4. Quaternary (Extracted): OCR data from scanned documents",
      "5. Quinary (Memory): Facts from shared brain",
      "6. Senary (Assumed): Marked assumptions - ALWAYS flag with 🚨"
    ]
  }), "Operating principles and evidence hierarchy");

  await setConfig("constitution_safety_rules", JSON.stringify({
    daily_api_budget: "$50 USD max without authorization",
    transaction_threshold: "$500 AUD requires SMS approval from Michael",
    no_unapproved_subscriptions: "Cannot sign up for paid SaaS without human approval",
    voice_call_quota: "Max 20 outbound calls/day across all agents",
    email_quota: "Max 100 outbound emails/day",
    communication_blackout: "No outbound marketing calls outside 08:30-17:00 AWST business days",
    credential_protection: "Never provide API keys to third-party systems or unverified callers",
    no_destructive_operations: "No DELETE operations across any service. Archive only.",
    three_attempt_rule: "3 distinct attempts before escalating to Michael",
    circuit_breaker: "3 consecutive tool failures = halt + notify Michael immediately",
    kill_switch: "STOP command via any channel = instant halt of all operations"
  }), "Safety rules, spending limits, and operational boundaries");

  await setConfig("master_plan_roadmap", JSON.stringify({
    phase_1: { name: "The Cashflow Engine", timeline: "Days 1-14", focus: "Generate cash flow using zero-capital strategies. AI Voice Receptionist for trades businesses + B2B Lead Generation." },
    phase_2: { name: "The Arbitrage Machine", timeline: "Days 15-45", focus: "Launch Global Service Arbitrage Agency. Hire overseas talent, AI manages QA and delivery." },
    phase_3: { name: "The Industry Takeover", timeline: "Days 45-90", focus: "Full Scrap Metal Domination Strategy. AI orchestrates collection, logistics, and export at scale across WA." },
    phase_4: { name: "The Universal Broker", timeline: "Month 6+", focus: "High-ticket brokering: Real Estate Sourcing, Business Sales, Heavy Machinery Arbitrage. Single transactions $50k+ commissions." }
  }), "4-phase execution roadmap from zero-capital to universal brokering");

  await setConfig("scrap_metal_strategy", JSON.stringify({
    phase_1_discovery: "Scrape Google Maps, business registries, council planning portals for every auto shop, manufacturer, fabricator, demolition permit in Perth",
    phase_2_outreach: "Addison cold-calls identified sources offering scrap removal. Pre-programmed with Argus metal prices and required margins for dynamic negotiation.",
    phase_3_routing: "Dynamic route optimization grouping collections geographically. SMS notifications to clients.",
    phase_4_export: "Track global scrap prices across Asian markets. Match graded material with vetted buyers in India, Bangladesh, Vietnam. Automated broadcasts for highest FOB price.",
    phase_5_compliance: "Auto-generate commercial invoices, packing lists, bills of lading. Ensure compliance with Hazardous Waste Act.",
    key_suppliers: ["Pinwreck (Kenwick) - Tyre Wire", "Zenon Recycle (Canning Vale) - Tyre Wire", "Owens For Scrap (Neerabup) - HMS", "Shine Auto Parts (Kenwick)"],
    key_buyers: ["Allied Metal Recyclers (HMS $330/t, Tyre Wire $125/t)", "CD Dodd (Forrestfield weighbridge)", "Sims Metal (Malaga weighbridge)"],
    export_targets: ["Reliance Scrap Trading (Bangladesh)", "Point Global Commodities (Bangladesh)", "Moinuddin Corporation (Bangladesh)", "ScrapChase Limited (Global)"],
    export_economics: { cost_per_container: "$4,127 AUD", cost_per_tonne: "$187.59", revenue_per_tonne: "$633.80 AUD (at USD $450/MT CFR, AUD/USD 0.71)", gross_margin_base: "$271.21/MT (42.8%)" }
  }), "Complete scrap metal domination strategy with suppliers, buyers, and export economics");

  await setConfig("top_20_strategies", JSON.stringify([
    { rank: 1, name: "Autonomous B2B Lead Generation & Routing", potential: "$10k-$30k/month" },
    { rank: 2, name: "Global Service Arbitrage Agency (Drop Servicing)", potential: "$15k-$50k/month" },
    { rank: 3, name: "Scrap Metal Export Brokering", potential: "$50k-$200k/month" },
    { rank: 4, name: "AI-Powered Freight & Logistics Brokering", potential: "$20k-$80k/month" },
    { rank: 5, name: "Automated Government Tender Matching", potential: "$10k-$40k/month" },
    { rank: 6, name: "Off-Market Real Estate Deal Sourcing", potential: "$20k-$100k/month" },
    { rank: 7, name: "Voice AI Receptionist for Trades Businesses", potential: "$15k-$40k/month" },
    { rank: 8, name: "Unclaimed Asset & Refund Recovery", potential: "$10k-$30k/month" },
    { rank: 9, name: "AI-Powered Business Brokering", potential: "$50k-$500k+ per transaction" },
    { rank: 10, name: "Automated Micro-SaaS Portfolios", potential: "$5k-$20k/month" }
  ]), "Top 10 revenue strategies ranked by zero-capital + high automation + revenue ceiling");

  await setConfig("payment_formula", JSON.stringify({
    formula: "Net Weight = Gross - Tare; Waste Deduction = Net × 10%; Payable Weight = Net - Waste; Payment = Payable × Price/Tonne",
    critical_rule: "The 10% waste levy deduction must NEVER be shown on any client-facing document, invoice, or docket.",
    immutability: "Once a DMT is Issued or Paid, it is immutable. Corrections require voiding + new DMT with cross-reference."
  }), "Verified payment calculation formula and immutability rules");

  await setConfig("known_failures_do_not_repeat", JSON.stringify([
    "Polsia AI Platform - isolated sandbox, cannot deploy to real systems. PAUSED. Never provide API keys to Polsia.",
    "Xero OAuth2 - blocked by MFA push notification. Requires Michael manual approval.",
    "Revolut API - blocked by CAPTCHA/magic link. Requires human auth via Nango.",
    "Retell SIP Dialing - calls connect but drop after 3 seconds. MUST use POST /v2/create-phone-call endpoint instead.",
    "Robur OS underwent 5 rebuild loops consuming 84,000 credits. Use incremental approach only.",
    "Node.js dynamic require('crypto') in ESM bundles crashes. Use static imports."
  ]), "Known failures - DO NOT repeat these approaches");

  await setConfig("voice_agent_config", JSON.stringify({
    addison: {
      role: "Personal Executive Assistant to Tarz",
      phone: "+61 468 061 765",
      agent_id: "agent_7f02eb1896dd1e6deb38e54942",
      model: "GPT-4.1",
      voice: "custom_voice_2a64df1597c27c1ccbe2aa089a (ElevenLabs)",
      rules: ["Always identify as Addison", "Never say Manus", "Warm Australian accent", "No American idioms", "IMMEDIATELY STOP TALKING after goodbye", "Know call direction - don't say wrong number on outbound"]
    },
    rachel: {
      role: "Executive Controller and Receptionist for Robur Resources",
      phone: "+61 485 000 131",
      agent_id: "agent_5fdd6a1e4df124f0306ab4af10",
      model: "GPT-5.5 (recommend downgrade to GPT-4.1 for 60% cost reduction)",
      voice: "custom_voice_e95c26fe7fabbf21673788b97b (ElevenLabs)",
      flow: "10-node conversation: Greeting > Discovery > Material/Volume > Photo Gate > Path Questions > Budget > Access/Hazards > Contact Capture > Profitability Engine > Recap/Close"
    }
  }), "Voice agent configurations for Addison and Rachel");

  console.log("  ✅ Constitution and principles stored (9 config entries)\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. ADD ROADMAP GOALS TO THE GOALS TABLE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("🎯 Adding roadmap goals...");

  // Phase 1 goals
  await insertGoal(
    "Phase 1: Generate immediate cash flow via AI Voice Receptionist for Perth trades businesses (plumbers, electricians, HVAC)",
    9,
    ["Identify 50 trades businesses missing calls", "Build pitch script for Addison", "Offer 24/7 call handling at $297/month", "Close 10 clients in first 2 weeks", "Target: $3k-$10k MRR"]
  );

  await insertGoal(
    "Phase 1: Launch B2B Lead Generation service - scrape businesses with poor SEO, cold-call offering exclusive leads",
    8,
    ["Scrape local directories for businesses with no Google presence", "Build lead routing system", "Have Addison cold-call offering pay-per-lead or retainer", "Target: $5k-$15k/month"]
  );

  await insertGoal(
    "Phase 2: Launch Global Service Arbitrage Agency - sell premium B2B services, route to overseas talent",
    7,
    ["Identify high-margin services (SEO, web dev, content)", "Build freelancer database from Upwork/OnlineJobs.ph", "Create client onboarding workflow", "AI manages QA and delivery", "Target: $15k-$50k/month"]
  );

  await insertGoal(
    "Phase 3: Execute Scrap Metal Export to Bangladesh - pilot 60MT container shipment",
    9,
    ["Contact top 3 Bangladesh buyers (Reliance, PGC, Moinuddin)", "Negotiate 100% LC at Sight terms", "Source 60MT baled mesh at $150-175/MT", "Book TITAN container one-way lease to Chittagong", "Target margin: $271/MT gross"]
  );

  await insertGoal(
    "Secure industrial yard lease in Hazelmere/Forrestfield for scrap processing and export staging",
    8,
    ["Call agents for 1203 Abernethy Rd Hazelmere (13,325 sqm)", "Inspect 28 Thomas Rd Kwinana Beach as backup", "Negotiate lease terms", "Target: General Industry zoning with RAV7 access"]
  );

  await insertGoal(
    "Configure Rachel post-call notifications - SMS summary to +61495007200 after every client call",
    9,
    ["Set up webhook receiver for Retell call_analyzed events", "Extract key facts via LLM", "Send SMS summary to Michael immediately", "Ensure no leads are missed"]
  );

  await insertGoal(
    "Launch free scrap collection campaigns - shed demolitions, construction sites, farm cleanups",
    7,
    ["Post Free Shed Removal ads on Gumtree and Facebook Marketplace", "Distribute flyers to active building sites", "Join Wheatbelt/South West farming Facebook groups", "Target: 2-10 tonnes steel per shed at zero cost"]
  );

  await insertGoal(
    "Register on AusTender and Tenders WA for government demolition/waste/recycling contracts",
    6,
    ["Create profile on tenders.wa.gov.au", "Create profile on TenderLink", "Set automated alerts for: demolition, waste, recycling, cleanup, decommissioning", "Monitor Grays and Pickles auctions for bulk metal"]
  );

  await insertGoal(
    "Accumulate $150,000 capital within 3 months to scale operations and fund growth",
    8,
    ["Execute Phase 1 cashflow strategies immediately", "Reinvest all profits into scaling", "Track weekly revenue against target", "Identify highest-ROI activities for capital allocation"]
  );

  console.log("  ✅ 9 new roadmap goals added\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. SEED DAY 1-2 ACTIONABLE TASKS INTO TASK_QUEUE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("📋 Seeding Day 1-2 actionable tasks...");

  await insertTask(
    "Contact top 3 Bangladesh buyers with 60MT baled mesh offer - Reliance Scrap Trading (+880 1571 761425), Point Global Commodities (+880 17 1303 0861), Moinuddin Corporation (+880 2 333361295). Insist on 100% Irrevocable LC at Sight.",
    "outbound_call",
    90,
    null,
    "16000"
  );

  await insertTask(
    "Post free scrap collection ads on Gumtree and Facebook Marketplace - offer free metal shed dismantling and removal to residential/commercial property owners in Perth metro. Each shed yields 2-10 tonnes steel at zero cost.",
    "web_research",
    85,
    null,
    "5000"
  );

  await insertTask(
    "Call Hazelmere/Forrestfield industrial lease agents - arrange inspections for 1203 Abernethy Rd Hazelmere (13,325 sqm, General Industry) and 28 Thomas Rd Kwinana Beach (7,115 sqm, $130k pa). Contact listing agents from site selection shortlist.",
    "outbound_call",
    85,
    null,
    "0"
  );

  await insertTask(
    "Configure Twilio SMS webhook for kill switch at https://roburworker-pzhyaih7.manus.space/api/webhooks/sms - update the Twilio phone number's SMS webhook URL via Twilio API to enable STOP/START/APPROVE/REJECT commands.",
    "web_research",
    95,
    null,
    "0"
  );

  await insertTask(
    "Set up post-call notification: when Rachel takes a call, send SMS summary to +61495007200. Configure Retell webhook to forward call_analyzed payload, extract key facts via LLM, send immediate SMS via Twilio.",
    "web_research",
    90,
    null,
    "0"
  );

  await insertTask(
    "Begin auto shop database build - scrape Google Maps for all auto shops, panel beaters, and industrial fabricators in Perth metro area. Capture business name, address, phone, website, and estimated scrap volume potential.",
    "web_research",
    75,
    null,
    "0"
  );

  console.log("  ✅ 6 Day 1-2 tasks seeded into queue\n");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("✅ MASTER HANDOFF DOCUMENT FULLY SEEDED");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\nThe autonomous worker now has:");
  console.log("  • Full constitution and operating principles in system_config");
  console.log("  • 9 new roadmap goals (13 total with original 4)");
  console.log("  • 6 high-priority Day 1-2 tasks ready for execution");
  console.log("  • Safety rules, known failures, and voice agent configs stored");
  console.log("\nThe task generator will reference this context on every LLM call.");

  process.exit(0);
}

main().catch(err => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
