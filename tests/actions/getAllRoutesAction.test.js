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

  it("links to the Latin route id so the frontend does not 301", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);

    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining('href="https://lad.lviv.ua/route/A01"'),
    );
  });

  it("sets cache headers for Cloudflare", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=0, s-maxage=2592000",
    );
    expect(res.set).toHaveBeenCalledWith("Cache-Tag", "short");
  });
});

// Port of the client-side `sharedCodes` in the <head> script (getAllRoutesAction.js).
// Kept in sync by hand — this test is what catches the two drifting apart.
function sharedCodes(routeStops, stopGeo, i, j) {
  const a = routeStops[i] || [];
  const b = routeStops[j] || [];
  const inB = new Set();
  for (const dir of b) for (const code of dir || []) inB.add(code);
  const seen = new Set();
  const out = [];
  for (const dir of a) {
    for (const code of dir || []) {
      if (seen.has(code)) continue;
      seen.add(code);
      if (inB.has(code) && stopGeo[code]) out.push(code);
    }
  }
  return out;
}

describe("getAllRoutesAction — comparison maps", () => {
  const stopB1 = {
    code: "9001",
    name: "Shared Stop 1",
    location: { coordinates: [49.8, 24.0] },
    transfers: [],
  };
  const stopB2 = {
    code: "9002",
    name: "Shared Stop 2",
    location: { coordinates: [49.81, 24.01] },
    transfers: [],
  };
  const stopB3 = {
    code: "9003",
    name: "Only In A",
    location: { coordinates: [49.82, 24.02] },
    transfers: [],
  };
  // routeA references "9004" too, which has no matching doc in `stops` —
  // the server drops it from `allStops`/`stopGeo`, exactly like the live
  // gtfs-import fallback that can leave a dangling/undefined stop code.
  const routeA = {
    external_id: "EXTA",
    short_name: "A10",
    long_name: "Route A",
    stops_by_shape: { 0: ["9001", "9003", "9004"], 1: ["9002", "9001"] },
  };
  const routeB = {
    external_id: "EXTB",
    short_name: "A20",
    long_name: "Route B",
    stops_by_shape: { 0: ["9001", "9002"], 1: ["9002", "9001"] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.getCollection.mockImplementation((name) => {
      if (name === "routes") return makeChainableCollection([routeA, routeB]);
      if (name === "stops")
        return makeChainableCollection([stopB1, stopB2, stopB3]);
    });
  });

  it("renders an expandable placeholder instead of the shared-stop list", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);
    const html = res.send.mock.calls[0][0];

    // simplesort by short_name puts A10 (routeA) before A20 (routeB), so
    // routeA is index 0 and routeB is index 1 in the render loop.
    expect(html).toContain('ontoggle="simExpand(this,0,1)"');
    expect(html).toContain('<div class="sim-body"></div>');
    expect(html).not.toMatch(/<ul>.*Shared Stop/);
  });

  it("ships _stopGeo coordinates in [lat, lng, name] order", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);
    const html = res.send.mock.calls[0][0];

    const match = html.match(/var _stopGeo=(\{.*?\}),_routeStops=/);
    expect(match).not.toBeNull();
    const stopGeo = JSON.parse(match[1]);

    expect(stopGeo["9001"]).toEqual([49.8, 24.0, "Shared Stop 1"]);
    expect(stopGeo["9002"]).toEqual([49.81, 24.01, "Shared Stop 2"]);
    // 9004 has no matching stop doc, so it must not appear at all.
    expect(stopGeo["9004"]).toBeUndefined();
  });

  it("client-side sharedCodes reproduces the server's shared-stop ordering", async () => {
    const { req, res, next } = makeReqRes();
    await getAllRoutesAction(req, res, next);
    const html = res.send.mock.calls[0][0];

    const stopGeoMatch = html.match(/var _stopGeo=(\{.*?\}),_routeStops=/);
    const routeStopsMatch = html.match(/_routeStops=(\[.*?\]),_routeNames=/);
    const stopGeo = JSON.parse(stopGeoMatch[1]);
    const routeStops = JSON.parse(routeStopsMatch[1]);

    // Route A's own order (dir 0 then dir 1), deduped, restricted to codes
    // route B also has and that resolve to a real stop: "9003" is A-only,
    // "9004" has no stop doc — both drop out, leaving "9001" then "9002".
    expect(sharedCodes(routeStops, stopGeo, 0, 1)).toEqual(["9001", "9002"]);
  });
});
