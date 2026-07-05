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
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
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

  // ─── Health Check ─────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), service: "robur-autonomous-worker" });
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
  });
}

startServer().catch(console.error);
