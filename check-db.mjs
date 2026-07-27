import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { systemConfig } from "./drizzle/schema.ts";

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

const result = await db.select().from(systemConfig).where(
  (col) => col.key.like("legacy_worker%")
);

console.log("Current config:");
console.log(JSON.stringify(result, null, 2));

await client.end();
