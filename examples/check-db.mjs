import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import "dotenv/config";

const db = drizzle(process.env.DATABASE_URL);

async function main() {
  // Check task queue
  const tasks = await db.execute(sql`SELECT id, LEFT(description, 80) as description, status, priorityScore, actionType, source FROM task_queue ORDER BY priorityScore DESC`);
  console.log("\n=== TASK QUEUE ===");
  console.log(`Total tasks: ${tasks[0].length}`);
  tasks[0].forEach(t => {
    console.log(`  [${t.id}] P${t.priorityScore} | ${t.status} | ${t.actionType} | ${t.source}`);
    console.log(`       ${t.description}`);
  });

  // Check goals
  const goals = await db.execute(sql`SELECT id, LEFT(goalText, 80) as goalText, status, priority FROM goals ORDER BY priority DESC`);
  console.log("\n=== GOALS ===");
  console.log(`Total goals: ${goals[0].length}`);
  goals[0].forEach(g => {
    console.log(`  [${g.id}] P${g.priority} | ${g.status} | ${g.goalText}`);
  });

  // Check system config count
  const configs = await db.execute(sql`SELECT COUNT(*) as cnt FROM system_config`);
  console.log(`\n=== SYSTEM CONFIG: ${configs[0][0].cnt} entries ===`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
