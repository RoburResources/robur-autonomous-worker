import type { NextFunction, Request, Response } from "express";
import { ENV } from "./env";
import { sdk } from "./sdk";

export async function requireOwnerHttpRequest(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (
      !ENV.ownerOpenId ||
      user.openId !== ENV.ownerOpenId ||
      user.role !== "admin"
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
}
