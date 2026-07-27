import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { systemConfig } from "./drizzle/schema";

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

const result = await db.select().from(systemConfig).where(
  (col) => col.key.like("legacy_worker%")
);

console.log("Current legacy worker config:");
result.forEach(row => console.log(`  ${row.key}: ${row.value}`));

const statusResult = await db.select().from(systemConfig).where(
  (col) => col.key.in(["system_status", "kill_switch_active"])
);

console.log("\nCurrent system status:");
statusResult.forEach(row => console.log(`  ${row.key}: ${row.value}`));

await client.end();
