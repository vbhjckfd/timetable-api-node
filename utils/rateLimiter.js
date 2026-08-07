/**
 * Simple in-memory rate limiter, one counter map per instance. Good enough for
 * a single running instance; would need a shared store (e.g. Redis) behind
 * more than one.
 */
export default function createRateLimiter({ limit, windowMs, onLimit, now = Date.now }) {
  const counts = new Map();

  return function rateLimiter(req, res, next) {
    const ip = req.ip ?? "unknown";
    const time = now();
    const entry = counts.get(ip) ?? { count: 0, windowStart: time };
    if (time - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = time;
    }
    entry.count++;
    counts.set(ip, entry);
    if (entry.count > limit) {
      return onLimit(res);
    }
    next();
  };
}
