import type { NextFunction, Request, RequestHandler, Response } from "express";

type RateLimitOptions = {
  max: number;
  windowMs: number;
  namespace: string;
  maxBuckets?: number;
};

type RateBucket = {
  count: number;
  resetAt: number;
};

function requestIsHttps(req: Request): boolean {
  if (req.secure || req.protocol === "https") return true;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const values = Array.isArray(forwardedProto)
    ? forwardedProto
    : String(forwardedProto || "").split(",");
  return values.some(value => value.trim().toLowerCase() === "https");
}

export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
  ].join("; "));
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (requestIsHttps(req)) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  next();
}

function getClientKey(req: Request, namespace: string): string {
  const address =
    req.socket?.remoteAddress ||
    "unknown";
  return `${namespace}:${String(address)}`;
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  if (
    !Number.isInteger(options.max) ||
    options.max < 1 ||
    !Number.isFinite(options.windowMs) ||
    options.windowMs < 1
  ) {
    throw new Error("Invalid rate-limit configuration");
  }

  const buckets = new Map<string, RateBucket>();
  const maxBuckets = options.maxBuckets ?? 10_000;

  function prune(now: number): void {
    const expired: string[] = [];
    buckets.forEach((bucket, key) => {
      if (bucket.resetAt <= now) expired.push(key);
    });
    expired.forEach(key => buckets.delete(key));
    while (buckets.size >= maxBuckets) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      buckets.delete(oldest);
    }
  }

  return (req, res, next) => {
    const now = Date.now();
    const key = getClientKey(req, options.namespace);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= maxBuckets) prune(now);
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(options.max - bucket.count, 0);
    const retryAfterSeconds = Math.max(
      Math.ceil((bucket.resetAt - now) / 1000),
      1
    );

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader(
      "RateLimit-Reset",
      String(Math.ceil(bucket.resetAt / 1000))
    );

    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    next();
  };
}

function requestOrigin(req: Request): string | null {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || req.get("host");
  return host ? `${protocol}://${host}` : null;
}

export function requireSameOriginMutation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    next();
    return;
  }

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    res.status(403).json({ error: "Cross-site request blocked" });
    return;
  }

  const suppliedOrigin = req.get("origin");
  const expectedOrigin = requestOrigin(req);
  if (suppliedOrigin && (!expectedOrigin || suppliedOrigin !== expectedOrigin)) {
    res.status(403).json({ error: "Cross-site request blocked" });
    return;
  }

  next();
}
