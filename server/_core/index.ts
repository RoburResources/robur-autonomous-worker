import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

// Scheduled handlers
import {
  taskGeneratorHandler,
  taskExecutorHandler,
  evaluatorHandler,
  selfImproverHandler,
  morningBriefingHandler,
  eveningBriefingHandler,
} from "../scheduled/handlers";
import { smsWebhookHandler } from "../scheduled/smsWebhook";
import { retellWebhookHandler } from "../scheduled/retellWebhook";
import { addisonVoiceWebhookHandler } from "../scheduled/voiceWebhook";
import { retellCreateTaskHandler } from "../scheduled/retellToolHandler";
import { startPrivateCandidateScheduler } from "../autonomous/privateCandidateScheduler";
import {
  enforceLegacyWorkerRetirement,
  getLegacyWorkerRuntimeGate,
} from "../safety/legacyWorkerGate";
import {
  createRateLimiter,
  requireSameOriginMutation,
  securityHeaders,
} from "./httpSecurity";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(
    "/api",
    createRateLimiter({
      max: 300,
      windowMs: 15 * 60 * 1000,
      namespace: "api",
    })
  );
  app.use(
    "/api/oauth",
    createRateLimiter({
      max: 20,
      windowMs: 15 * 60 * 1000,
      namespace: "oauth",
    })
  );
  app.use(
    "/api/webhooks",
    createRateLimiter({
      max: 60,
      windowMs: 60 * 1000,
      namespace: "webhooks",
    })
  );
  app.use(
    "/manus-storage",
    createRateLimiter({
      max: 120,
      windowMs: 15 * 60 * 1000,
      namespace: "storage",
    })
  );

  const startupGate = await enforceLegacyWorkerRetirement();
  console.log(
    startupGate.allowed
      ? "[Safety] Legacy worker environment enabled; persisted owner authorization still controls execution"
      : "[Safety] Legacy worker is retired/paused"
  );
  // This service has no direct upload route. Keep request bodies tightly bounded.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  app.use("/api/trpc", requireSameOriginMutation);
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // ─── Scheduled Cron Endpoints ─────────────────────────────────────────────
  // These MUST be mounted before the Vite/static fallthrough
  app.post("/api/scheduled/task-generator", taskGeneratorHandler);
  app.post("/api/scheduled/task-executor", taskExecutorHandler);
  app.post("/api/scheduled/evaluator", evaluatorHandler);
  app.post("/api/scheduled/self-improver", selfImproverHandler);
  app.post("/api/scheduled/morning-briefing", morningBriefingHandler);
  app.post("/api/scheduled/evening-briefing", eveningBriefingHandler);

  // ─── Webhooks ─────────────────────────────────────────────────────────────
  app.post("/api/webhooks/sms", smsWebhookHandler);
  app.post("/api/webhooks/retell", retellWebhookHandler);
  app.post("/api/webhooks/voice/addison", addisonVoiceWebhookHandler);
  app.post("/api/webhooks/retell/create-task", retellCreateTaskHandler);

  // ─── Health Check ─────────────────────────────────────────────────────────
  app.get("/api/health", async (_req, res) => {
    const gate = await getLegacyWorkerRuntimeGate();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "robur-autonomous-worker",
      legacyWorkerStatus: gate.allowed ? "enabled" : "retired_or_paused",
      autonomousExecution: gate.allowed,
    });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    startPrivateCandidateScheduler();
  });
}

startServer().catch(console.error);
