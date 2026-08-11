import { providerWebhookInbox } from "../../drizzle/schema";
import { getDb } from "../db";

type ReadinessDatabase = {
  select: (selection: { id: unknown }) => {
    from: (table: unknown) => {
      limit: (count: number) => Promise<unknown>;
    };
  };
};

export type ServiceReadiness =
  | { ready: true; databaseSchema: "ready" }
  | {
      ready: false;
      databaseSchema: "database_unavailable" | "migration_required";
    };

export async function getServiceReadiness(
  databaseOverride?: ReadinessDatabase | null
): Promise<ServiceReadiness> {
  const database =
    databaseOverride === undefined
      ? ((await getDb()) as ReadinessDatabase | null)
      : databaseOverride;
  if (!database) {
    return { ready: false, databaseSchema: "database_unavailable" };
  }

  try {
    await database
      .select({ id: providerWebhookInbox.id })
      .from(providerWebhookInbox)
      .limit(1);
    return { ready: true, databaseSchema: "ready" };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    return {
      ready: false,
      databaseSchema:
        code === "ER_NO_SUCH_TABLE"
          ? "migration_required"
          : "database_unavailable",
    };
  }
}

export async function startBackgroundWorkersWhenReady(
  workers: Array<() => unknown>,
  readinessCheck: () => Promise<ServiceReadiness> = getServiceReadiness
): Promise<boolean> {
  const readiness = await readinessCheck();
  if (!readiness.ready) return false;

  for (const start of workers) start();
  return true;
}
