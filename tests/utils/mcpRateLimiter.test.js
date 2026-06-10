import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpRateLimiter } from "../../utils/mcpRateLimiter.js";

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status: vi.fn().mockImplementation(function (c) { this.statusCode = c; return this; }),
    json: vi.fn().mockImplementation(function (b) { this.body = b; return this; }),
  };
}

function hit(limiter, ip = "1.2.3.4") {
  const res = makeRes();
  const next = vi.fn();
  limiter({ ip }, res, next);
  return { res, next };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("createMcpRateLimiter", () => {
  it("passes requests under the limit through", () => {
    const limiter = createMcpRateLimiter({ limit: 3 });

    for (let i = 0; i < 3; i++) {
      const { res, next } = hit(limiter);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects with a 429 JSON-RPC error above the limit", () => {
    const limiter = createMcpRateLimiter({ limit: 2 });

    hit(limiter);
    hit(limiter);
    const { res, next } = hit(limiter);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });
  });

  it("tracks IPs independently", () => {
    const limiter = createMcpRateLimiter({ limit: 1 });

    hit(limiter, "1.1.1.1");
    const blocked = hit(limiter, "1.1.1.1");
    const allowed = hit(limiter, "2.2.2.2");

    expect(blocked.res.statusCode).toBe(429);
    expect(allowed.next).toHaveBeenCalled();
  });

  it("resets the window after windowMs", () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const limiter = createMcpRateLimiter({ limit: 1, windowMs: 60_000 });

    hit(limiter);
    expect(hit(limiter).res.statusCode).toBe(429);

    nowSpy.mockReturnValue(base + 60_001);
    expect(hit(limiter).next).toHaveBeenCalled();
  });

  it("sweeps stale IP entries so the map stays bounded", () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const limiter = createMcpRateLimiter({
      limit: 5,
      windowMs: 60_000,
      sweepIntervalMs: 5 * 60_000,
    });

    for (let i = 0; i < 100; i++) hit(limiter, `10.0.0.${i}`);
    expect(limiter.store.size).toBe(100);

    // Past the sweep interval, a single new request evicts all expired windows
    nowSpy.mockReturnValue(base + 5 * 60_000 + 1);
    hit(limiter, "fresh-ip");

    expect(limiter.store.size).toBe(1);
    expect(limiter.store.has("fresh-ip")).toBe(true);
  });
});
