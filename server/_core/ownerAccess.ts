import { COOKIE_NAME } from "@shared/const";
import type { Express, Request, Response } from "express";
import { jwtVerify } from "jose";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import {
  createRateLimiter,
  requireSameOriginMutation,
} from "./httpSecurity";
import { sdk } from "./sdk";

const OWNER_SESSION_MS = 12 * 60 * 60 * 1000;
const ownerAccessLimiter = createRateLimiter({
  max: 10,
  windowMs: 15 * 60 * 1000,
  namespace: "private-owner-access",
});

function privateCandidateEnabled(): boolean {
  return (
    process.env.PRIVATE_CANDIDATE_INTERNAL_ONLY === "true" &&
    process.env.PRIVATE_CANDIDATE_INTERNAL_AUTONOMY === "true"
  );
}

function rejectOwnerAccess(res: Response): void {
  res.status(403).json({ error: "Invalid or expired owner access link" });
}

export function registerOwnerAccessRoutes(app: Express) {
  app.post(
    "/api/private-owner/access",
    ownerAccessLimiter,
    requireSameOriginMutation,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");

      if (!privateCandidateEnabled()) {
        res.status(404).json({ error: "Not found" });
        return;
      }

      const token =
        req.body && typeof req.body.token === "string" ? req.body.token : "";
      if (!token || !ENV.cookieSecret || !ENV.ownerOpenId || !ENV.appId) {
        rejectOwnerAccess(res);
        return;
      }

      try {
        const { payload } = await jwtVerify(
          token,
          new TextEncoder().encode(ENV.cookieSecret),
          { algorithms: ["HS256"] }
        );

        const jti = typeof payload.jti === "string" ? payload.jti : "";
        const expiresAt =
          typeof payload.exp === "number"
            ? new Date(payload.exp * 1000)
            : new Date(Number.NaN);
        if (
          payload.purpose !== "private_owner_access" ||
          payload.openId !== ENV.ownerOpenId ||
          payload.appId !== ENV.appId ||
          !jti ||
          !(await db.claimPrivateOwnerAccessToken(jti, expiresAt))
        ) {
          rejectOwnerAccess(res);
          return;
        }

        await db.upsertUser({
          openId: ENV.ownerOpenId,
          name: "Michael",
          role: "admin",
          loginMethod: "private_candidate",
          lastSignedIn: new Date(),
        });

        const sessionToken = await sdk.createSessionToken(ENV.ownerOpenId, {
          name: "Michael",
          expiresInMs: OWNER_SESSION_MS,
        });
        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          sameSite: "lax",
          maxAge: OWNER_SESSION_MS,
        });
        res.status(200).json({
          sessionToken,
          expiresAt: new Date(Date.now() + OWNER_SESSION_MS).toISOString(),
        });
      } catch {
        rejectOwnerAccess(res);
      }
    }
  );

  app.all("/api/private-owner/access", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  app.all("/api/oauth/callback", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
}
