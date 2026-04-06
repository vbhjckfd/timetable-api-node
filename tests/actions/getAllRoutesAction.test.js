import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeReqRes, makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import getAllRoutesAction from "../../actions/getAllRoutesAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStop = {
  code: "1001",
  name: "Stop A",
  location: { coordinates: [49.845, 24.023] },
  transfers: [],
};

const mockRoute = {
  external_id: "EXT1",
  short_name: "А01",
  long_name: "Route One",
  stops_by_shape: { 0: ["1001", "1002"], 1: ["1002", "1001"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getCollection.mockImplementation((name) => {
    if (name === "routes") return makeChainableCollection([mockRoute]);
    if (name === "stops") return makeChainableCollection([mockStop]);
  });
});

describe("getAllRoutesAction", () => {
  it("renders an HTML table with route data", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<table>"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("А01"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Route One"));
  });

  it("sets cache-control header", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage=3600"),
    );
  });
});
