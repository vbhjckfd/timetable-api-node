import { describe, it, expect } from "vitest";
import { isInternalCaller } from "../../utils/internalCaller.ts";

const req = (key) => ({ headers: key === undefined ? {} : { "x-internal-key": key } });

describe("isInternalCaller", () => {
  it("accepts only the configured key", () => {
    expect(isInternalCaller(req("s3cret"), "s3cret")).toBe(true);
    expect(isInternalCaller(req("s3cret!"), "s3cret")).toBe(false);
    expect(isInternalCaller(req("wrong!"), "s3cret")).toBe(false);
    expect(isInternalCaller(req(undefined), "s3cret")).toBe(false);
  });

  it("exempts nobody when no key is configured", () => {
    expect(isInternalCaller(req(""), "")).toBe(false);
    expect(isInternalCaller(req("anything"), undefined)).toBe(false);
  });
});
