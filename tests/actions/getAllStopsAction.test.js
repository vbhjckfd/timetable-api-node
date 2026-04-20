import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeReqRes, makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import getAllStopsAction from "../../actions/getAllStopsAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStop = {
  code: 1001,
  name: "Central Stop",
  eng_name: "Central Stop EN",
  location: { coordinates: [49.845, 24.023] },
  transfers: [{ route: "А01" }, { route: "Т1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getCollection.mockReturnValue(makeChainableCollection([mockStop]));
});

describe("getAllStopsAction", () => {
  it("returns JSON array for .json path", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops.json" });
    await getAllStopsAction(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          code: 1001,
          name: "Central Stop",
          eng_name: "Central Stop EN",
          location: [49.845, 24.023],
          routes: expect.arrayContaining(["А01", "Т1"]),
        }),
      ]),
    );
  });

  it("returns HTML table for non-json path", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops" });
    await getAllStopsAction(req, res, next);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<table>"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("1001"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("Central Stop"),
    );
  });

  it("sets long cache headers for Cloudflare", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops.json" });
    await getAllStopsAction(req, res, next);

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=0, s-maxage=2592000",
    );
    expect(res.set).toHaveBeenCalledWith("Cache-Tag", "long");
  });
});
