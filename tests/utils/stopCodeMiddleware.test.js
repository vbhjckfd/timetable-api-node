import { describe, it, expect, vi } from "vitest";
import validateStopCode from "../../utils/stopCodeMiddleware.js";

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  };
}

describe("validateStopCode middleware", () => {
  it("calls next() and sets req.stopCode for a valid numeric code", () => {
    const req = { params: { code: "1001" } };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.stopCode).toBe(1001);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric code string", () => {
    const req = { params: { code: "abc" } };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when code is zero", () => {
    const req = { params: { code: "0" } };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 when code is empty string", () => {
    const req = { params: { code: "" } };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("redirects a suffixed code like 0074-01 to the trimmed stop code", () => {
    const req = { params: { code: "0074-01" }, path: "/stops/0074-01/timetable", originalUrl: "/stops/0074-01/timetable?x=1" };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(301, "/stops/74/timetable?x=1");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 400 for a suffixed code with a zero stop part", () => {
    const req = { params: { code: "0000-01" }, path: "/stops/0000-01", originalUrl: "/stops/0000-01" };
    const res = makeRes();
    const next = vi.fn();

    validateStopCode(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects without a sub-path or query string", () => {
    const req = { params: { code: "0074-01" }, path: "/stops/0074-01", originalUrl: "/stops/0074-01" };
    const res = makeRes();

    validateStopCode(req, res, vi.fn());

    expect(res.redirect).toHaveBeenCalledWith(301, "/stops/74");
  });
});
