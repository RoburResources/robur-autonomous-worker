import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import { jwtVerify } from "jose";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { ENV } from "./env";
import { sdk } from "./sdk";

const usedPrivateOwnerAccessTokens = new Set<string>();

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/private-owner/access", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    if (
      process.env.PRIVATE_CANDIDATE_INTERNAL_ONLY !== "true" ||
      process.env.PRIVATE_CANDIDATE_INTERNAL_AUTONOMY !== "true"
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const token = getQueryParam(req, "token");
    if (!token || !ENV.cookieSecret || !ENV.ownerOpenId || !ENV.appId) {
      res.status(403).json({ error: "Invalid or expired owner access link" });
      return;
    }

    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(ENV.cookieSecret),
        { algorithms: ["HS256"] }
      );

      const jti = typeof payload.jti === "string" ? payload.jti : "";
      if (
        payload.purpose !== "private_owner_access" ||
        payload.openId !== ENV.ownerOpenId ||
        payload.appId !== ENV.appId ||
        !jti ||
        usedPrivateOwnerAccessTokens.has(jti)
      ) {
        res.status(403).json({ error: "Invalid or expired owner access link" });
        return;
      }

      usedPrivateOwnerAccessTokens.add(jti);
      await db.upsertUser({
        openId: ENV.ownerOpenId,
        name: "Michael",
        role: "admin",
        loginMethod: "private_candidate",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(ENV.ownerOpenId, {
        name: "Michael",
        expiresInMs: ONE_YEAR_MS,
      });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, {
        ...cookieOptions,
        maxAge: ONE_YEAR_MS,
      });
      res.redirect(302, "/");
    } catch {
      res.status(403).json({ error: "Invalid or expired owner access link" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
