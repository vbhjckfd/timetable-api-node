import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/microgizService.js", () => ({
  getArrivalTimes: vi.fn(),
  getVehiclesLocations: vi.fn(),
}));

vi.mock("gtfs", () => ({
  getTrips: vi.fn(),
  getCalendars: vi.fn().mockResolvedValue([{ service_id: "SVC1" }]),
}));

import stopArrivalService from "../../services/stopArrivalService.js";
import db from "../../connections/timetableSqliteDb.js";
import {
  getArrivalTimes,
  getVehiclesLocations,
} from "../../services/microgizService.js";
import { getTrips } from "gtfs";

const futureTimeSec = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now

const testStop = {
  code: 1001,
  microgiz_id: "MG1001",
  name: "Central Stop",
  transfers: [
    {
      _id: "x",
      id: "ROUTE1",
      route: "А01",
      color: "#ff0000",
      vehicle_type: "bus",
      shape_id: "S1",
      direction_id: 0,
    },
  ],
};

const mockRoute = {
  external_id: "ROUTE1",
  short_name: "А01",
  trip_shape_map: { TRIP1: "S1" },
  trip_direction_map: { TRIP1: 0 },
  shapes: { S1: [[49.845, 24.023]], S2: [[49.846, 24.024]] },
};

const mockArrivalEntity = {
  tripUpdate: {
    stopTimeUpdate: [{ stopId: "MG1001", arrival: { time: futureTimeSec } }],
    trip: { routeId: "ROUTE1", tripId: "TRIP1" },
    vehicle: { id: "VH1" },
  },
};

const mockVehicleEntity = {
  vehicle: {
    vehicle: { id: "VH1", licensePlate: "BC-1234-AB" },
    position: { latitude: 49.845, longitude: 24.023, bearing: 90 },
    trip: { routeId: "ROUTE1", tripId: "TRIP1" },
  },
};

const mockTrip = {
  trip_id: "TRIP1",
  route_id: "ROUTE1",
  trip_headsign: "Destination (12)",
  wheelchair_accessible: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stopArrivalService.getTimetableForStop", () => {
  it("returns empty array when no arrivals match the stop", async () => {
    db.getCollection.mockReturnValue({ find: vi.fn().mockReturnValue([]) });
    getArrivalTimes.mockResolvedValue([]);
    getVehiclesLocations.mockResolvedValue([]);

    const result = await stopArrivalService.getTimetableForStop(testStop);

    expect(result).toEqual([]);
  });

  it("filters out arrival entities not matching the stop microgiz_id", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getArrivalTimes.mockResolvedValue([
      {
        tripUpdate: {
          stopTimeUpdate: [
            { stopId: "DIFFERENT_STOP", arrival: { time: futureTimeSec } },
          ],
          trip: { routeId: "ROUTE1", tripId: "TRIP1" },
          vehicle: { id: "VH1" },
        },
      },
    ]);
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getTrips.mockResolvedValue([mockTrip]);

    const result = await stopArrivalService.getTimetableForStop(testStop);

    expect(result).toHaveLength(0);
  });

  it("returns formatted timetable entries for matching arrivals", async () => {
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getArrivalTimes.mockResolvedValue([mockArrivalEntity]);
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getTrips.mockResolvedValue([mockTrip]);

    const result = await stopArrivalService.getTimetableForStop(testStop);

    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.route_id).toBe("ROUTE1");
    expect(entry.vehicle_id).toBe("VH1");
    expect(entry.bearing).toBe(90);
    expect(entry.location).toEqual(["49.84500", "24.02300"]);
    expect(entry.route).toBe("А01");
    expect(entry.end_stop).toBe("Destination"); // cleanUpStopName strips "(12)"
    expect(entry.arrival_time).toBeDefined();
    expect(entry.time_left).toMatch(/хв$/);
  });

  it("filters out past arrivals", async () => {
    const pastTimeSec = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const pastArrival = {
      tripUpdate: {
        stopTimeUpdate: [{ stopId: "MG1001", arrival: { time: pastTimeSec } }],
        trip: { routeId: "ROUTE1", tripId: "TRIP1" },
        vehicle: { id: "VH1" },
      },
    };
    db.getCollection.mockReturnValue({
      find: vi.fn().mockReturnValue([mockRoute]),
    });
    getArrivalTimes.mockResolvedValue([pastArrival]);
    getVehiclesLocations.mockResolvedValue([mockVehicleEntity]);
    getTrips.mockResolvedValue([mockTrip]);

    const result = await stopArrivalService.getTimetableForStop(testStop);

    expect(result).toHaveLength(0);
  });
});
