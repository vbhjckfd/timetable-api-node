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

  it("still answers with the position when the arrivals feed fails", async () => {
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getArrivalTimes.mockRejectedValue(new Error("trip_updates down"));
    db.getCollection.mockImplementation((name) => {
      if (name === "stops") return { find: vi.fn().mockReturnValue([]) };
      if (name === "routes") return { findOne: vi.fn().mockReturnValue(mockRoute) };
    });

    const res = makeRes();
    await vehicleInfoAction({ params: { vehicleId: "VH42" } }, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ vehicleId: "VH42", location: [49.845, 24.023], arrivals: [] }),
    );
  });

  it("ignores trip updates without a vehicle descriptor", async () => {
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getArrivalTimes.mockResolvedValue([{ tripUpdate: { vehicle: null, stopTimeUpdate: [] } }, mockArrivalEntity]);
    db.getCollection.mockImplementation((name) => {
      if (name === "stops") return { find: vi.fn().mockReturnValue([mockStop]) };
      if (name === "routes") return { findOne: vi.fn().mockReturnValue(mockRoute) };
    });

    const res = makeRes();
    await vehicleInfoAction({ params: { vehicleId: "VH42" } }, res, vi.fn());

    expect(res.send.mock.calls[0][0].arrivals).toHaveLength(1);
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
        vehicleId: "VH42",
        routeId: "EXT1",
        bearing: 180,
        licensePlate: "BC-4242",
        location: [49.845, 24.023],
      }),
    );
    expect(res.send.mock.calls[0][0].arrivals[0]).toMatchObject({
      code: 1001,
      name: "Stop A",
    });
  });

  it("reports a missing licence plate as null, not an empty string", async () => {
    getVehiclesLocations.mockResolvedValue([
      {
        vehicle: {
          ...mockVehicleEntity.vehicle,
          vehicle: { id: "VH42", licensePlate: "" },
        },
      },
    ]);
    getArrivalTimes.mockResolvedValue([]);
    db.getCollection.mockImplementation((name) => {
      if (name === "stops") return { find: vi.fn().mockReturnValue([]) };
      if (name === "routes") return { findOne: vi.fn().mockReturnValue(mockRoute) };
    });

    const res = makeRes();
    await vehicleInfoAction({ params: { vehicleId: "VH42" } }, res, vi.fn());

    expect(res.send.mock.calls[0][0].licensePlate).toBeNull();
  });

  it("marks a low-floor vehicle with the same rule as the route feed", async () => {
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getArrivalTimes.mockResolvedValue([]);
    db.getCollection.mockImplementation((name) => {
      if (name === "stops") return { find: vi.fn().mockReturnValue([]) };
      // А52 is on the all-low-floor bus list in isLowFloor.
      if (name === "routes")
        return { findOne: vi.fn().mockReturnValue({ ...mockRoute, short_name: "А52" }) };
    });

    const res = makeRes();
    await vehicleInfoAction({ params: { vehicleId: "VH42" } }, res, vi.fn());

    expect(res.send.mock.calls[0][0].lowfloor).toBe(true);
  });

  it("reports lowfloor false when the route is not in the local dataset", async () => {
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getArrivalTimes.mockResolvedValue([]);
    db.getCollection.mockImplementation((name) => {
      if (name === "stops") return { find: vi.fn().mockReturnValue([]) };
      if (name === "routes") return { findOne: vi.fn().mockReturnValue(null) };
    });

    const res = makeRes();
    await vehicleInfoAction({ params: { vehicleId: "VH42" } }, res, vi.fn());

    expect(res.send.mock.calls[0][0].lowfloor).toBe(false);
  });
});
