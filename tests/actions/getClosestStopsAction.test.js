import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import getClosestStopsAction from "../../actions/getClosestStopsAction.js";
import db from "../../connections/timetableSqliteDb.js";

// Lviv area coordinates for realistic geodist tests
const TARGET_LAT = 49.845;
const TARGET_LON = 24.023;

const nearStop = {
  code: 1,
  name: "Near Stop",
  location: { coordinates: [TARGET_LAT, TARGET_LON] }, // ~0m away
};
const farStop = {
  code: 2,
  name: "Far Stop",
  location: { coordinates: [49.86, TARGET_LON] }, // ~1670m away — outside 1km
};
const midStop = {
  code: 3,
  name: "Mid Stop",
  location: { coordinates: [49.848, TARGET_LON] }, // ~333m away
};

function makeRes() {
  return { set: vi.fn().mockReturnThis(), json: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getClosestStopsAction", () => {
  it("returns only stops within 1km", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([nearStop, farStop, midStop]),
    });

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await getClosestStopsAction(req, res);

    const result = res.json.mock.calls[0][0];
    const codes = result.map((s) => s.code);
    expect(codes).toContain(1);
    expect(codes).toContain(3);
    expect(codes).not.toContain(2);
  });

  it("sorts results by ascending distance", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([midStop, nearStop]),
    });

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await getClosestStopsAction(req, res);

    const result = res.json.mock.calls[0][0];
    expect(result[0].code).toBe(1); // nearStop first
    expect(result[1].code).toBe(3); // midStop second
  });

  it("returns correct shape for each stop", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([nearStop]),
    });

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await getClosestStopsAction(req, res);

    expect(res.json).toHaveBeenCalledWith([
      {
        code: 1,
        name: "Near Stop",
        latitude: TARGET_LAT,
        longitude: TARGET_LON,
      },
    ]);
  });

  it("sets no-cache when no stops are found", async () => {
    db.getCollection.mockReturnValue({ find: vi.fn().mockReturnValue([]) });

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await getClosestStopsAction(req, res);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-cache");
  });

  it("sets long cache when stops are found", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([nearStop]),
    });

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await getClosestStopsAction(req, res);

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage="),
    );
  });
});
