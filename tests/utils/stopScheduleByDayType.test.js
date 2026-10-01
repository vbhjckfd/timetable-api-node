import { describe, it, expect } from "vitest";

import { stopScheduleByDayType } from "../../utils/stopScheduleByDayType.js";

describe("stopScheduleByDayType", () => {
  it("returns separate Saturday and Sunday timetables", () => {
    const route = {
      stop_departure_time_map_workday: { 1: ["06:05"] },
      stop_departure_time_map_weekend: { 1: ["06:05", "07:05"] },
      stop_departure_time_map_saturday: { 1: ["06:05"] },
      stop_departure_time_map_sunday: { 1: ["07:05"] },
    };

    expect(stopScheduleByDayType(route, 1)).toEqual({
      workday: ["06:05"],
      saturday: ["06:05"],
      sunday: ["07:05"],
      weekend: ["06:05", "07:05"],
    });
  });

  it("treats a stop missing from an existing day map as no service that day", () => {
    const route = {
      stop_departure_time_map_weekend: { 1: ["08:00"] },
      stop_departure_time_map_saturday: { 1: ["08:00"] },
      stop_departure_time_map_sunday: {},
    };

    expect(stopScheduleByDayType(route, 1).sunday).toEqual([]);
  });

  it("falls back to the weekend map for routes imported before the split", () => {
    const route = { stop_departure_time_map_weekend: { 1: ["08:00"] } };

    const schedule = stopScheduleByDayType(route, 1);
    expect(schedule.saturday).toEqual(["08:00"]);
    expect(schedule.sunday).toEqual(["08:00"]);
    expect(schedule.workday).toEqual([]);
  });
});
