import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/microgizService.js", () => ({
  getVehiclesLocations: vi.fn(),
  getArrivalTimes: vi.fn(),
}));

import vehicleInfoAction from "../../actions/vehicleInfoAction.js";
import db from "../../connections/timetableSqliteDb.js";
import {
  getVehiclesLocations,
  getArrivalTimes,
} from "../../services/microgizService.js";

const mockVehicleEntity = {
  vehicle: {
    vehicle: { id: "VH42", licensePlate: "BC-4242" },
    position: { latitude: 49.845, longitude: 24.023, bearing: 180 },
    trip: { routeId: "EXT1", tripId: "TRIP1" },
  },
};

const mockStop = {
  microgiz_id: "MG1001",
  code: 1001,
  name: "Stop A",
  transfers: [{ _id: "x", route: "А01" }],
};

const mockRoute = {
  external_id: "EXT1",
  short_name: "А01",
  trip_direction_map: { TRIP1: 0 },
};

const mockArrivalEntity = {
  tripUpdate: {
    vehicle: { id: "VH42" },
    stopTimeUpdate: [
      {
        stopId: "MG1001",
        stopSequence: 1,
        arrival: { time: 1000 },
        departure: null,
      },
    ],
  },
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

describe("vehicleInfoAction", () => {
  it("returns 404 when vehicle is not found", async () => {
    getVehiclesLocations.mockResolvedValue([]);
    getArrivalTimes.mockResolvedValue([]);

    const req = { params: { vehicleId: "UNKNOWN" } };
    const res = makeRes();
    await vehicleInfoAction(req, res, vi.fn());

    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });

  it("returns vehicle data when vehicle is found", async () => {
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getArrivalTimes.mockResolvedValue([mockArrivalEntity]);

    db.getCollection.mockImplementation((name) => {
      if (name === "stops")
        return { find: vi.fn().mockReturnValue([mockStop]) };
      if (name === "routes")
        return { findOne: vi.fn().mockReturnValue(mockRoute) };
    });

    const req = { params: { vehicleId: "VH42" } };
    const res = makeRes();
    await vehicleInfoAction(req, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "EXT1",
        bearing: 180,
        licensePlate: "BC-4242",
        location: [49.845, 24.023],
      }),
    );
  });
});
