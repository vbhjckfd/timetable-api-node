import { describe, it, expect, vi } from "vitest";
import validateStopCode from "../../utils/stopCodeMiddleware.js";

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
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
});
