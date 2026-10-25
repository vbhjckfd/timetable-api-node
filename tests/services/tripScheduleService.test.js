import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import db from "../../connections/timetableSqliteDb.js";
import {
  atMinutes,
  kyivClock,
  parseTripTime,
  rideMinutes,
  scheduledHeadway,
  scheduleTrip,
} from "../../services/tripScheduleService.js";

const stop = (code) => ({ code, microgiz_id: `MG${code}` });
const STOPS = [stop(1), stop(2), stop(3), stop(4), stop(5)];

// R1 runs 1 → 2 → 3 every 10 min from 07:00, 12 min end to end (2 min to stop 2).
// R2 runs 3 → 4 → 5 every 15 min from 07:05, 4 stops' worth of 3 min each.
const every = (start, step, count, offset = 0) =>
  Array.from({ length: count }, (_, i) => {
    const m = start + i * step + offset;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  });
const workday = (stops) => ({ stop_departure_time_map_workday: stops, stop_departure_time_map: stops });
const ROUTES = [
  {
    external_id: "R1",
    stops_by_shape: { 0: [1, 2, 3], 1: [3, 2, 1] },
    ...workday({ MG1: every(420, 10, 6), MG2: every(420, 10, 6, 2), MG3: every(420, 10, 6, 12) }),
  },
  {
    external_id: "R2",
    stops_by_shape: { 0: [3, 4, 5], 1: [5, 4, 3] },
    ...workday({ MG3: every(425, 15, 4), MG4: every(425, 15, 4, 6), MG5: every(425, 15, 4, 12) }),
  },
];

function collection(rows) {
  const matches = (row, query) => Object.entries(query).every(([key, value]) => row[key] === value);
  return {
    find: vi.fn((query = {}) => rows.filter((r) => matches(r, query))),
    findOne: vi.fn((query) => rows.find((r) => matches(r, query)) ?? null),
  };
}

beforeEach(() => {
  const stops = collection(STOPS);
  const routes = collection(ROUTES);
  db.getCollection.mockImplementation((name) => (name === "stops" ? stops : routes));
});

// Thursday 1 Jan 2026, 07:03 in Kyiv (UTC+2).
const THU_0703 = new Date("2026-01-01T05:03:00.000Z");

describe("kyivClock / atMinutes", () => {
  it("reads the Lviv wall clock whatever the host zone", () => {
    expect(kyivClock(THU_0703)).toEqual({ weekday: 4, minutes: 423 });
    expect(atMinutes(THU_0703, 8 * 60).toISOString()).toBe("2026-01-01T06:00:00.000Z");
  });
});

describe("parseTripTime", () => {
  it("reads HH:MM as Lviv time today and passes ISO through", () => {
    expect(parseTripTime("08:30", THU_0703)?.toISOString()).toBe("2026-01-01T06:30:00.000Z");
    expect(parseTripTime("2026-01-02T09:00:00+02:00")?.toISOString()).toBe("2026-01-02T07:00:00.000Z");
  });

  it("rejects anything else", () => {
    expect(parseTripTime("25:00", THU_0703)).toBeNull();
    expect(parseTripTime("soon", THU_0703)).toBeNull();
    expect(parseTripTime("2026-13-45T00:00:00Z")).toBeNull();
  });
});

describe("rideMinutes", () => {
  it("takes the median offset of paired departures", () => {
    expect(rideMinutes([420, 430, 440], [432, 442, 453], 2)).toBe(12);
  });

  it("pairs the first trips when the lists differ in length", () => {
    expect(rideMinutes([420, 430, 440], [427, 437], 2)).toBe(7);
  });

  it("falls back to a per-stop average when the lists do not line up", () => {
    // Alight before board: these are not the same trips.
    expect(rideMinutes([430], [420], 3)).toBe(6);
    expect(rideMinutes([], [], 4)).toBe(8);
  });
});

describe("scheduleTrip", () => {
  const leg1 = { route_id: "R1", board_code: 1, alight_code: 3, stops_count: 2 };
  const leg2 = { route_id: "R2", board_code: 3, alight_code: 5, stops_count: 2 };
  const walks = (to, from = 0, transfer = []) => ({ to_board_meters: to, transfer_meters: transfer, from_alight_meters: from });

  it("catches the first departure after the walk to the stop", () => {
    // Leave 07:03, 160 m is 2 min: on the stop at 07:05, next R1 at 07:10.
    expect(scheduleTrip([leg1], walks(160, 80), { depart_at: THU_0703 })).toEqual({
      leave_at: "07:03",
      arrive_at: "07:23",
      total_minutes: 20,
      legs: [{ board_at: "07:10", alight_at: "07:22" }],
    });
  });

  it("chains a transfer onto the first departure after the interchange walk", () => {
    // R1 07:10 → stop 3 at 07:22, 1 min walk, R2 at 07:35 → stop 5 at 07:47.
    const trip = scheduleTrip([leg1, leg2], walks(160, 0, [80]), { depart_at: THU_0703 });
    expect(trip?.legs).toEqual([
      { board_at: "07:10", alight_at: "07:22" },
      { board_at: "07:35", alight_at: "07:47" },
    ]);
    expect(trip?.total_minutes).toBe(44);
  });

  it("works back from an arrival time to when to leave", () => {
    // Be at stop 3 by 07:45 with no walk: R1 07:30 arrives 07:42; leave 2 min earlier.
    const arriveBy = atMinutes(THU_0703, 7 * 60 + 45);
    expect(scheduleTrip([leg1], walks(160), { arrive_by: arriveBy })).toEqual({
      leave_at: "07:28",
      arrive_at: "07:42",
      total_minutes: 14,
      legs: [{ board_at: "07:30", alight_at: "07:42" }],
    });
  });

  it("is null after the day's last departure, or on a day without service", () => {
    expect(scheduleTrip([leg1], walks(0), { depart_at: atMinutes(THU_0703, 23 * 60) })).toBeNull();
    // Saturday 3 Jan: these routes only have a workday timetable.
    expect(scheduleTrip([leg1], walks(0), { depart_at: new Date("2026-01-03T06:00:00.000Z") })).toBeNull();
  });
});

describe("scheduledHeadway", () => {
  it("is the typical gap between departures from the first stop around now", () => {
    expect(scheduledHeadway("R1", 0, THU_0703)).toBe(10);
    expect(scheduledHeadway("R2", 0, THU_0703)).toBe(15);
  });

  it("is null outside service hours or for an unknown route", () => {
    expect(scheduledHeadway("R1", 0, atMinutes(THU_0703, 22 * 60))).toBeNull();
    expect(scheduledHeadway("NOPE", 0, THU_0703)).toBeNull();
  });
});
