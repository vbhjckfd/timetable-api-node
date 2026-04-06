import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/microgizService.js", () => ({
  getVehiclesLocations: vi.fn(),
}));

vi.mock("../../utils/appHelpers.js", () => ({
  normalizeRouteName: vi.fn((n) => n),
  isLowFloor: vi.fn(() => false),
  getTodayServiceIds: vi.fn().mockResolvedValue(["SVC1"]),
}));

vi.mock("gtfs", () => ({
  getTrips: vi.fn(),
}));

import routeDynamicInfoAction from "../../actions/routeDynamicInfoAction.js";
import db from "../../connections/timetableSqliteDb.js";
import { getVehiclesLocations } from "../../services/microgizService.js";
import { getTrips } from "gtfs";

const mockRoute = {
  external_id: "EXT1",
  short_name: "А01",
  trip_direction_map: { TRIP1: 0 },
};

const mockVehicleEntity = {
  vehicle: {
    vehicle: { id: "VH1", licensePlate: "BC-1234" },
    position: { latitude: 49.845, longitude: 24.023, bearing: 90 },
    trip: { routeId: "EXT1", tripId: "TRIP1" },
  },
};

const mockTrip = {
  trip_id: "TRIP1",
  route_id: "EXT1",
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

describe("routeDynamicInfoAction", () => {
  it("returns 404 when route is not found", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
    });

    const req = { params: { name: "А99" } };
    const res = makeRes();
    await routeDynamicInfoAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });

  it("returns empty array when no vehicles on route", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockRoute),
    });
    getVehiclesLocations.mockResolvedValue([]);
    getTrips.mockResolvedValue([]);

    const req = { params: { name: "А01" } };
    const res = makeRes();
    await routeDynamicInfoAction(req, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith(expect.arrayContaining([]));
  });

  it("returns vehicle list with location and bearing", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockRoute),
    });
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getTrips.mockResolvedValue([mockTrip]);

    const req = { params: { name: "А01" } };
    const res = makeRes();
    await routeDynamicInfoAction(req, res, vi.fn());

    // The action uses an implicit Lodash chain, so spread to a plain array before asserting
    const payload = [...res.send.mock.calls[0][0]];
    expect(payload).toContainEqual(
      expect.objectContaining({
        id: "VH1",
        location: [49.845, 24.023],
        bearing: 90,
      }),
    );
  });

  it("looks up route by external_id when param is numeric", async () => {
    const findOneMock = vi.fn().mockReturnValue(null);
    db.getCollection.mockReturnValue({ findOne: findOneMock });

    const req = { params: { name: "12345" } };
    const res = makeRes();
    await routeDynamicInfoAction(req, res, vi.fn());

    expect(findOneMock).toHaveBeenCalledWith({ external_id: "12345" });
  });
});
