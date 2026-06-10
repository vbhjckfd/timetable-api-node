// Simple in-memory fixed-window rate limiter for the MCP endpoint.
// Stale IP entries are swept periodically so the map cannot grow without
// bound under rotating client IPs.
export function createMcpRateLimiter({
  limit = 60,
  windowMs = 60_000,
  sweepIntervalMs = 5 * 60_000,
} = {}) {
  const hits = new Map();
  let lastSweepAt = Date.now();

  function middleware(req, res, next) {
    const ip = req.ip ?? "unknown";
    const now = Date.now();

    if (now - lastSweepAt > sweepIntervalMs) {
      for (const [key, entry] of hits) {
        if (now - entry.windowStart > windowMs) hits.delete(key);
      }
      lastSweepAt = now;
    }

    const entry = hits.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    hits.set(ip, entry);

    if (entry.count > limit) {
      return res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Rate limit exceeded. Try again later." },
        id: null,
      });
    }
    next();
  }

  middleware.store = hits; // test seam
  return middleware;
}
