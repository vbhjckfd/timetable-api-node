import { describe, it, expect, vi } from "vitest";
import createRateLimiter from "../../utils/rateLimiter.js";

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

describe("createRateLimiter", () => {
  it("calls next() under the limit", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, onLimit: vi.fn() });
    const next = vi.fn();

    limiter({ ip: "1.2.3.4" }, makeRes(), next);
    limiter({ ip: "1.2.3.4" }, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("calls onLimit instead of next() once the limit is exceeded", () => {
    const onLimit = vi.fn();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, onLimit });
    const next = vi.fn();

    limiter({ ip: "1.2.3.4" }, makeRes(), next);
    const res = makeRes();
    limiter({ ip: "1.2.3.4" }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledWith(res);
  });

  it("tracks each IP separately", () => {
    const onLimit = vi.fn();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, onLimit });
    const next = vi.fn();

    limiter({ ip: "1.1.1.1" }, makeRes(), next);
    limiter({ ip: "2.2.2.2" }, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("resets the count once the window has passed", () => {
    const onLimit = vi.fn();
    let time = 0;
    const limiter = createRateLimiter({
      limit: 1,
      windowMs: 1000,
      onLimit,
      now: () => time,
    });
    const next = vi.fn();

    limiter({ ip: "1.2.3.4" }, makeRes(), next);
    time = 2000;
    limiter({ ip: "1.2.3.4" }, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("does not crash on a request with no ip", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, onLimit: vi.fn() });
    const next = vi.fn();

    expect(() => limiter({}, makeRes(), next)).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
  });
});
