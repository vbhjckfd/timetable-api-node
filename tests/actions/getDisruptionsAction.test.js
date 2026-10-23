import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeReqRes } from "../helpers/mockHelpers.js";

vi.mock("../../services/disruptionService.js", () => ({
  activeDisruptions: vi.fn(() => [{ id: "x" }]),
}));

import getDisruptionsAction from "../../actions/getDisruptionsAction.js";
import { activeDisruptions } from "../../services/disruptionService.js";

beforeEach(() => vi.clearAllMocks());

describe("getDisruptionsAction", () => {
  it("lists everything in force without a filter, on a short CDN TTL", () => {
    const { req, res } = makeReqRes();
    getDisruptionsAction(req, res);

    expect(activeDisruptions).toHaveBeenCalledWith(undefined);
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "public, max-age=0, s-maxage=300");
    expect(res.set).toHaveBeenCalledWith("Cache-Tag", "long");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ disruptions: [{ id: "x" }] }));
  });

  it("passes route and stop on as a filter", () => {
    const { req, res } = makeReqRes({ query: { route: " A34 ", stop: "707" } });
    getDisruptionsAction(req, res);
    expect(activeDisruptions).toHaveBeenCalledWith({ routes: ["A34"], stops: [707] });
  });

  it("rejects a stop that is not a code", () => {
    const { req, res } = makeReqRes({ query: { stop: "opera" } });
    getDisruptionsAction(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(activeDisruptions).not.toHaveBeenCalled();
  });
});
