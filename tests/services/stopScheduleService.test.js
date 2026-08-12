import { describe, it, expect } from "vitest";

import { getScheduledArrivalsForStop } from "../../services/stopScheduleService.js";

const stop = {
  code: 694,
  microgiz_id: "4755",
  name: "Рясне-1",
  transfers: [
    {
      _id: "x",
      id: "ROUTE1",
      route: "А47",
      color: "#0E4F95",
      vehicle_type: "bus",
      shape_id: "S1",
      direction_id: 0,
      end_stop_name: "Рясне-2 (12)",
      end_stop_code: 655,
    },
    {
      _id: "y",
      id: "ROUTE2",
      route: "А06",
      color: "#0E4F95",
      vehicle_type: "bus",
      shape_id: "S2",
      direction_id: 1,
      end_stop_name: "Рясне-2",
      end_stop_code: 655,
    },
  ],
};

const routesByRouteId = {
  ROUTE1: {
    external_id: "ROUTE1",
    stop_departure_time_map: { 4755: ["12:00", "12:30"] },
    stop_departure_time_map_workday: { 4755: ["11:50", "12:05", "12:20", "12:35"] },
    stop_departure_time_map_weekend: { 4755: ["12:15"] },
  },
  ROUTE2: {
    external_id: "ROUTE2",
    stop_departure_time_map: { 4755: ["12:10"] },
    stop_departure_time_map_workday: { 4755: ["12:10"] },
    stop_departure_time_map_weekend: { 4755: ["13:40"] },
  },
};

/** A Wednesday and a Saturday at 12:00 local time. */
const workday = new Date(2026, 7, 12, 12, 0, 0);
const weekend = new Date(2026, 7, 15, 12, 0, 0);

describe("getScheduledArrivalsForStop", () => {
  it("returns upcoming workday departures sorted by time", () => {
    const result = getScheduledArrivalsForStop(stop, routesByRouteId, { now: workday });

    expect(result.map((i) => i.route)).toEqual(["А47", "А06", "А47"]);
    expect(result.map((i) => new Date(i.arrival_time).getHours())).toEqual([12, 12, 12]);
    expect(result.map((i) => new Date(i.arrival_time).getMinutes())).toEqual([5, 10, 20]);
  });

  it("drops departures that already passed", () => {
    const result = getScheduledArrivalsForStop(stop, routesByRouteId, { now: workday });

    // 11:50 is behind `now` and must not resurface as an arrival.
    expect(result.some((i) => new Date(i.arrival_time).getMinutes() === 50)).toBe(false);
  });

  it("uses the weekend map on weekends", () => {
    const result = getScheduledArrivalsForStop(stop, routesByRouteId, { now: weekend });

    expect(result).toHaveLength(1);
    expect(result[0].route).toBe("А47");
    expect(new Date(result[0].arrival_time).getMinutes()).toBe(15);
  });

  it("caps how many departures a single route contributes", () => {
    const busy = {
      ROUTE1: {
        external_id: "ROUTE1",
        stop_departure_time_map_workday: {
          4755: ["12:05", "12:10", "12:15", "12:20", "12:25"],
        },
      },
    };

    const result = getScheduledArrivalsForStop(stop, busy, { now: workday });

    expect(result).toHaveLength(2);
  });

  it("ignores departures beyond the lookahead window", () => {
    const result = getScheduledArrivalsForStop(stop, routesByRouteId, {
      now: workday,
      windowMinutes: 7,
    });

    expect(result.map((i) => new Date(i.arrival_time).getMinutes())).toEqual([5]);
  });

  it("marks entries as scheduled and carries route metadata, without a vehicle", () => {
    const [entry] = getScheduledArrivalsForStop(stop, routesByRouteId, { now: workday });

    expect(entry.scheduled).toBe(true);
    expect(entry.route_id).toBe("ROUTE1");
    expect(entry.color).toBe("#0E4F95");
    expect(entry.vehicle_type).toBe("bus");
    expect(entry.direction_id).toBe(0);
    expect(entry.end_stop).toBe("Рясне-2"); // cleanUpStopName strips "(12)"
    expect(entry.time_left).toMatch(/хв$/);
    expect(entry.vehicle_id).toBeUndefined();
    expect(entry.location).toBeUndefined();
    expect(entry._id).toBeUndefined();
  });

  it("falls back to the combined map when the day-specific one is missing", () => {
    const combinedOnly = {
      ROUTE1: {
        external_id: "ROUTE1",
        stop_departure_time_map: { 4755: ["12:45"] },
      },
    };

    const result = getScheduledArrivalsForStop(stop, combinedOnly, { now: workday });

    expect(result).toHaveLength(1);
    expect(new Date(result[0].arrival_time).getMinutes()).toBe(45);
  });

  it("returns nothing for a stop with no transfers or no known routes", () => {
    expect(getScheduledArrivalsForStop({ microgiz_id: "4755" }, routesByRouteId, { now: workday })).toEqual([]);
    expect(getScheduledArrivalsForStop(stop, {}, { now: workday })).toEqual([]);
  });

  it("skips malformed time strings", () => {
    const broken = {
      ROUTE1: {
        external_id: "ROUTE1",
        stop_departure_time_map_workday: { 4755: ["", "25:00", "12:99", "12:05"] },
      },
    };

    const result = getScheduledArrivalsForStop(stop, broken, { now: workday });

    expect(result).toHaveLength(1);
    expect(new Date(result[0].arrival_time).getMinutes()).toBe(5);
  });
});
