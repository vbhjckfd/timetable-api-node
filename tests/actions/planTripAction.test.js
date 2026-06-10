import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../utils/appHelpers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, formatRouteName: vi.fn((n) => n) };
});

import planTripAction, { __resetRoutesIndexCache } from "../../actions/planTripAction.js";
import db from "../../connections/timetableSqliteDb.js";

// Minimal stop records
const stops = [
  { code: 100, name: "Origin", location: { coordinates: [49.84, 24.01] } },
  { code: 200, name: "Middle", location: { coordinates: [49.85, 24.02] } },
  { code: 300, name: "Destination", location: { coordinates: [49.86, 24.03] } },
  { code: 400, name: "Transfer Hub", location: { coordinates: [49.87, 24.04] } },
  { code: 500, name: "Final", location: { coordinates: [49.88, 24.05] } },
];

// Route A: 100 → 200 → 300 (direct path from 100 to 300)
const routeA = {
  short_name: "А01",
  stops_by_shape: { "0": [100, 200, 300], "1": [300, 200, 100] },
};

// Route B: 100 → 400 → 500 (goes to 400 from origin but not to 300)
// Route C: 400 → 300 (connects transfer at 400 to destination 300)
const routeB = {
  short_name: "А02",
  stops_by_shape: { "0": [100, 400, 500], "1": [500, 400, 100] },
};
const routeC = {
  short_name: "А03",
  stops_by_shape: { "0": [400, 300, 200], "1": [200, 300, 400] },
};

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockImplementation(function (b) { this.body = b; return this; }),
    status: vi.fn().mockImplementation(function (c) { this.statusCode = c; return this; }),
  };
  return res;
}

function setupDb(routes) {
  db.getCollection.mockImplementation((name) => {
    if (name === "routes") return { find: vi.fn().mockReturnValue(routes) };
    if (name === "stops") return {
      find: vi.fn().mockReturnValue(stops),
      findOne: vi.fn().mockImplementation(({ code }) => stops.find((s) => s.code === code) ?? null),
    };
    return { find: vi.fn().mockReturnValue([]), findOne: vi.fn().mockReturnValue(null) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRoutesIndexCache();
});

describe("planTripAction", () => {
  it("returns direct trip when a single route serves both stops", async () => {
    setupDb([routeA]);
    const req = { query: { origin: "100", destination: "300" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(200);
    const { options, origin, destination } = res.body;
    expect(origin.id).toBe("100");
    expect(destination.id).toBe("300");
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options[0].type).toBe("direct");
    expect(options[0].route).toBe("А01");
    expect(options[0].stops_count).toBe(2);
  });

  it("returns transfer trip when no direct route exists", async () => {
    // routeB goes origin(100) → transfer(400); routeC goes transfer(400) → destination(300)
    setupDb([routeB, routeC]);
    const req = { query: { origin: "100", destination: "300" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(200);
    const { options } = res.body;
    expect(options.length).toBeGreaterThanOrEqual(1);
    const transfer = options.find((o) => o.type === "transfer");
    expect(transfer).toBeDefined();
    expect(transfer.route1).toBe("А02");
    expect(transfer.route2).toBe("А03");
    expect(transfer.transfer_stop_code).toBe(400);
  });

  it("returns direct before transfer when both are possible", async () => {
    setupDb([routeA, routeB, routeC]);
    const req = { query: { origin: "100", destination: "300" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.options[0].type).toBe("direct");
  });

  it("returns 400 for same origin and destination", async () => {
    setupDb([routeA]);
    const req = { query: { origin: "100", destination: "100" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid stop code", async () => {
    setupDb([routeA]);
    const req = { query: { origin: "abc", destination: "300" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when origin stop not found in DB", async () => {
    setupDb([routeA]);
    const req = { query: { origin: "9999", destination: "300" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(404);
  });

  it("returns empty options when no path exists between two valid stops", async () => {
    // routeA only serves 100→200→300; neither 200→500 nor transfer exists
    setupDb([routeA]);
    const req = { query: { origin: "200", destination: "500" } };
    const res = makeRes();
    await planTripAction(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.options).toHaveLength(0);
  });

  it("builds the routes index once and reuses it across requests", async () => {
    // Route data only changes on import + restart, so the per-request
    // routes×stops index rebuild is pure waste.
    const routesFind = vi.fn().mockReturnValue([routeA]);
    const stopsFind = vi.fn().mockReturnValue(stops);
    db.getCollection.mockImplementation((name) => {
      if (name === "routes") return { find: routesFind };
      if (name === "stops") return {
        find: stopsFind,
        findOne: vi.fn().mockImplementation(({ code }) => stops.find((s) => s.code === code) ?? null),
      };
    });

    for (const destination of ["300", "200"]) {
      const res = makeRes();
      await planTripAction({ query: { origin: "100", destination } }, res);
      expect(res.statusCode).toBe(200);
    }

    expect(routesFind).toHaveBeenCalledTimes(1);
    expect(stopsFind).toHaveBeenCalledTimes(1);
  });
});
