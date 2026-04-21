import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../utils/appHelpers.js", () => ({
  normalizeRouteName: vi.fn((n) => n),
  getRouteColor: vi.fn(() => "#00ff00"),
  getRouteType: vi.fn(() => "tram"),
}));

import routeFinalStopScheduleAction from "../../actions/routeFinalStopScheduleAction.js";
import db from "../../connections/timetableSqliteDb.js";

const stopA = {
  code: "1001",
  name: "Stop A",
  eng_name: "Stop A EN",
  location: { coordinates: [49.845, 24.023] },
  microgiz_id: "MG1001",
};

const stopB = {
  code: "1002",
  name: "Stop B",
  eng_name: "Stop B EN",
  location: { coordinates: [49.846, 24.024] },
  microgiz_id: "MG1002",
};

const mockRoute = {
  external_id: "EXT1",
  short_name: "T1",
  long_name: "Tram One",
  shapes: { size: 2 },
  stops_by_shape: {
    0: ["1001", "1002"],
    1: ["1002", "1001"],
  },
  stop_departure_time_map: {
    MG1002: ["09:10", "09:40"],
    MG1001: ["10:05", "10:35"],
  },
};

function makeRes() {
  return {
    sendStatus: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("routeFinalStopScheduleAction", () => {
  it("returns 404 when route is not found", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
      find: vi.fn().mockReturnValue([]),
    });

    const req = { params: { name: "T99" } };
    const res = makeRes();
    await routeFinalStopScheduleAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });

  it("returns 500 when route has fewer than 2 shapes", async () => {
    const routeWithOneShape = { ...mockRoute, shapes: { size: 1 } };
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(routeWithOneShape),
      find: vi.fn().mockReturnValue([]),
    });

    const req = { params: { name: "T1" } };
    const res = makeRes();
    await routeFinalStopScheduleAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(500);
  });

  it("returns terminus departure schedules for both directions", async () => {
    db.getCollection.mockImplementation((name) => {
      if (name === "routes")
        return { findOne: vi.fn().mockReturnValue(mockRoute), find: vi.fn() };
      if (name === "stops") return { find: vi.fn().mockReturnValue([stopA, stopB]) };
    });

    const req = { params: { name: "T1" } };
    const res = makeRes();
    await routeFinalStopScheduleAction(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "EXT1",
        route_short_name: "T1",
        directions: [
          expect.objectContaining({
            direction: 0,
            terminus: expect.objectContaining({ code: "1002", microgiz_id: "MG1002" }),
            departures: ["09:10", "09:40"],
          }),
          expect.objectContaining({
            direction: 1,
            terminus: expect.objectContaining({ code: "1001", microgiz_id: "MG1001" }),
            departures: ["10:05", "10:35"],
          }),
        ],
      }),
    );
  });
});
