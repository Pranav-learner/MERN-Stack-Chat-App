/**
 * @module middleware/rateLimiter
 *
 * Lightweight, zero-dependency rate limiter with in-memory tracking
 * and optional Redis acceleration. Designed for auth endpoint brute-force protection.
 */

import redis from "../lib/redis.js";

const memoryStore = new Map();

// Periodic cleanup of expired in-memory entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.resetAt <= now) {
      memoryStore.delete(key);
    }
  }
}, 60000).unref();

export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000; // default 15 minutes
  const max = options.max || 10; // max attempts per window
  const message = options.message || "Too many requests from this IP, please try again later.";
  const keyPrefix = options.keyPrefix || "rl";

  return async function rateLimiter(req, res, next) {
    // In test environment, allow bypassing or higher threshold unless explicitly testing rate limits
    if (process.env.NODE_ENV === "test" && req.headers["x-bypass-ratelimit"] === "true") {
      return next();
    }

    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    // Check Redis if available
    if (redis && redis.status === "ready") {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, windowMs);
        }
        const ttl = await redis.pttl(key);
        const remaining = Math.max(0, max - count);

        res.setHeader("RateLimit-Limit", max);
        res.setHeader("RateLimit-Remaining", remaining);
        res.setHeader("RateLimit-Reset", Math.ceil((now + ttl) / 1000));

        if (count > max) {
          res.setHeader("Retry-After", Math.ceil(ttl / 1000));
          return res.status(429).json({
            success: false,
            message,
          });
        }
        return next();
      } catch (err) {
        // Fall back to in-memory store on Redis failure
      }
    }

    // In-memory fallback
    let entry = memoryStore.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 1, resetAt: now + windowMs };
      memoryStore.set(key, entry);
    } else {
      entry.count += 1;
    }

    const remaining = Math.max(0, max - entry.count);
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);

    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > max) {
      res.setHeader("Retry-After", retryAfterSeconds);
      return res.status(429).json({
        success: false,
        message,
      });
    }

    return next();
  };
}

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many authentication attempts, please try again in 15 minutes.",
  keyPrefix: "auth",
});
