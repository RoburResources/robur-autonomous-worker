import type { Request, Response } from "express";

type RequestWithRawBody = Request & { rawBody?: string };

/**
 * Preserve the exact JSON bytes for providers whose signatures cover the raw
 * request body. The normal parsed body remains available to route handlers.
 */
export function captureRawJsonBody(
  req: Request,
  _res: Response,
  buffer: Buffer
): void {
  (req as RequestWithRawBody).rawBody = buffer.toString("utf8");
}

export function getRawJsonBody(req: Request): string | null {
  const rawBody = (req as RequestWithRawBody).rawBody;
  return typeof rawBody === "string" ? rawBody : null;
}
