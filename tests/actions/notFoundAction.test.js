import { describe, it, expect, vi } from "vitest";
import notFoundAction from "../../actions/notFoundAction.js";

describe("notFoundAction", () => {
  it("sends 404 status", () => {
    const res = { sendStatus: vi.fn() };
    notFoundAction({}, res, vi.fn());
    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });
});
