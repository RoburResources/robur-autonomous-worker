import { getDb, setConfig } from "./server/db";

async function unlock() {
  const db = await getDb();
  if (!db) {
    console.error("❌ Database connection failed");
    process.exit(1);
  }

  console.log("🔓 Unlocking legacy worker...");
  
  try {
    await setConfig(
      "legacy_worker_owner_authorized",
      "true",
      "Verified owner resume - automated unlock"
    );
    await setConfig(
      "kill_switch_active",
      "false",
      "Resumed by verified owner - automated unlock"
    );
    await setConfig(
      "system_status",
      "active",
      "Resumed by verified owner - automated unlock"
    );
    
    console.log("✅ Legacy worker unlocked successfully");
    console.log("   - legacy_worker_owner_authorized: true");
    console.log("   - kill_switch_active: false");
    console.log("   - system_status: active");
  } catch (error) {
    console.error("❌ Unlock failed:", error);
    process.exit(1);
  }
}

unlock();
