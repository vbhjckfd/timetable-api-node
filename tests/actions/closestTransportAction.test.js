import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/microgizService.js", () => ({
  getVehiclesLocations: vi.fn(),
}));

vi.mock("../../utils/appHelpers.js", () => ({
  getRouteColor: vi.fn(() => "#ff0000"),
  formatRouteName: vi.fn((n) => n),
  getRouteType: vi.fn(() => "bus"),
  isLowFloor: vi.fn(() => false),
  getTodayServiceIds: vi.fn().mockResolvedValue(["SVC1"]),
}));

vi.mock("gtfs", () => ({
  getTrips: vi.fn(),
}));

import closestTransportAction from "../../actions/closestTransportAction.js";
import db from "../../connections/timetableSqliteDb.js";
import { getVehiclesLocations } from "../../services/microgizService.js";
import { getTrips } from "gtfs";

const TARGET_LAT = 49.845;
const TARGET_LON = 24.023;

const mockRoute = {
  external_id: "EXT1",
  short_name: "А01",
  trip_direction_map: { TRIP1: 0 },
};

// Vehicle near the target point
const nearVehicleEntity = {
  vehicle: {
    vehicle: { id: "VH1", licensePlate: "BC-1" },
    position: { latitude: TARGET_LAT, longitude: TARGET_LON, bearing: 45 },
    trip: { routeId: "EXT1", tripId: "TRIP1" },
  },
};

// Vehicle far from the target point
const farVehicleEntity = {
  vehicle: {
    vehicle: { id: "VH2", licensePlate: "BC-2" },
    position: {
      latitude: TARGET_LAT + 0.05,
      longitude: TARGET_LON,
      bearing: 90,
    },
    trip: { routeId: "EXT1", tripId: "TRIP2" },
  },
};

const mockTrip = { trip_id: "TRIP1", route_id: "EXT1" };

function makeRes() {
  return {
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("closestTransportAction", () => {
  it("returns empty array when no vehicles are nearby", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getVehiclesLocations.mockResolvedValue([farVehicleEntity]);
    getTrips.mockResolvedValue([]);

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await closestTransportAction(req, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith([]);
  });

  it("returns only vehicles within 1km", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getVehiclesLocations.mockResolvedValue([
      nearVehicleEntity,
      farVehicleEntity,
    ]);
    getTrips.mockResolvedValue([mockTrip]);

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await closestTransportAction(req, res, vi.fn());

    const result = res.send.mock.calls[0][0];
    expect(Array.isArray(result)).toBe(true);
    const ids = result.map((v) => v.id);
    expect(ids).toContain("VH1");
    expect(ids).not.toContain("VH2");
  });

  it("returns vehicle with location and bearing fields", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getVehiclesLocations.mockResolvedValue([nearVehicleEntity]);
    getTrips.mockResolvedValue([mockTrip]);

    const req = {
      query: { latitude: String(TARGET_LAT), longitude: String(TARGET_LON) },
    };
    const res = makeRes();
    await closestTransportAction(req, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "VH1",
          location: [TARGET_LAT, TARGET_LON],
          bearing: 45,
        }),
      ]),
    );
  });
});
