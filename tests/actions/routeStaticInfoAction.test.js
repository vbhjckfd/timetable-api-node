import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../utils/appHelpers.js", () => ({
  normalizeRouteName: vi.fn((n) => n),
  shapes_by_direction: vi.fn(() => [[[49.845, 24.023]], [[49.846, 24.024]]]),
  secondsUntilImportDone: vi.fn(() => 3600),
  getRouteColor: vi.fn(() => "#ff0000"),
  getRouteType: vi.fn(() => "bus"),
}));

import routeStaticInfoAction from "../../actions/routeStaticInfoAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStop = {
  code: "1001",
  name: "Stop A",
  eng_name: "Stop A EN",
  location: { coordinates: [49.845, 24.023] },
  microgiz_id: "MG1001",
  transfers: [{ _id: "x", route: "А01", shape_id: "S1", vehicle_type: "bus" }],
};

const mockRoute = {
  external_id: "EXT1",
  short_name: "А01",
  long_name: "Route One",
  shapes: { size: 2 }, // mock object with size property
  stops_by_shape: { 0: ["1001"], 1: ["1001"] },
  stop_departure_time_map: { MG1001: ["08:00", "08:30"] },
};

function makeRes() {
  return {
    sendStatus: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("routeStaticInfoAction", () => {
  it("returns 404 when route is not found", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
      find: vi.fn().mockReturnValue([]),
    });

    const req = { params: { name: "А99" } };
    const res = makeRes();
    await routeStaticInfoAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });

  it("returns 500 when route has fewer than 2 shapes", async () => {
    const routeWithOneShape = { ...mockRoute, shapes: { size: 1 } };
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(routeWithOneShape),
      find: vi.fn().mockReturnValue([]),
    });

    const req = { params: { name: "А01" } };
    const res = makeRes();
    await routeStaticInfoAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(500);
  });

  it("returns route data on success", async () => {
    db.getCollection.mockImplementation((name) => {
      if (name === "routes")
        return { findOne: vi.fn().mockReturnValue(mockRoute), find: vi.fn() };
      if (name === "stops")
        return { find: vi.fn().mockReturnValue([mockStop]) };
    });

    const req = { params: { name: "А01" } };
    const res = makeRes();
    await routeStaticInfoAction(req, res, vi.fn());

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=0, s-maxage=2592000",
    );
    expect(res.set).toHaveBeenCalledWith("Cache-Tag", "long");
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "EXT1",
        route_short_name: "А01",
        route_long_name: "Route One",
        color: "#ff0000",
        type: "bus",
      }),
    );
  });

  it("looks up route by numeric external_id when param is numeric", async () => {
    const findOneMock = vi.fn().mockReturnValue(null);
    db.getCollection.mockReturnValue({ findOne: findOneMock, find: vi.fn() });

    const req = { params: { name: "12345" } };
    const res = makeRes();
    await routeStaticInfoAction(req, res, vi.fn());

    expect(findOneMock).toHaveBeenCalledWith({ external_id: "12345" });
  });
});
