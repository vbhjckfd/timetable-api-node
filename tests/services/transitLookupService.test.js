import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/microgizService.js", () => ({
  getArrivalTimes: vi.fn(),
}));

import db from "../../connections/timetableSqliteDb.js";
import { getArrivalTimes } from "../../services/microgizService.js";
import {
  destinationsFor,
  findRoutesBetween,
  listRouteNames,
  TRANSFER_RADIUS_METERS,
  etasForVehicles,
  nextStopsForVehicles,
  POINT_WALK_RADIUS_METERS,
  resolveRoute,
  searchStops,
} from "../../services/transitLookupService.js";

const stop = (code, name, lat, lng, extra = {}) => ({
  code,
  name,
  eng_name: null,
  microgiz_id: `MG${code}`,
  location: { coordinates: [lat, lng] },
  transfers: [],
  ...extra,
});

// Two "Опера" platforms across the street, one far-away namesake, a stop under
// another name a short walk from 707, and a line of stops for the routes below.
const STOPS = [
  stop(707, "Опера", 49.8437, 24.0263, { eng_name: "Opera", transfers: [{ route: "Т01" }, { route: "А03" }] }),
  stop(708, "Опера", 49.8440, 24.0268, { eng_name: "Opera", transfers: [{ route: "Т02" }] }),
  stop(900, "Опера", 49.80, 24.10),
  stop(10, "Площа Ринок", 49.8415, 24.0323, { eng_name: "Rynok Square" }),
  stop(11, "Підвальна", 49.8428, 24.0349),
  stop(12, "Вокзал", 49.8395, 23.9940),
  stop(13, "Маріїʼна", 49.845, 24.02),
  stop(14, "Театр опери та балету", 49.844, 24.026, { eng_name: "Opera and Ballet Theatre" }),
  stop(15, "Автовокзал", 49.80, 24.00),
  stop(16, "Залізничний вокзал", 49.8398, 23.9945),
  stop(17, "Руська", 49.8446, 24.0275),
  // Across the street from «Підвальна» (~30 m): an interchange cluster.
  stop(20, "Друкарська", 49.8430, 24.0352),
  stop(21, "Личаківська", 49.8350, 24.0600),
  stop(22, "Сихів", 49.7900, 24.0600),
];

const ROUTES = [
  // Т01 dir 0: 707 → 10 → 11 → 12; dir 1 reversed.
  { external_id: "1", short_name: "Т01", stops_by_shape: { 0: [707, 10, 11, 12], 1: [12, 11, 10, 707] } },
  // Т02 dir 0 serves the other platform, and reaches 12 in fewer stops.
  { external_id: "2", short_name: "Т02", stops_by_shape: { 0: [708, 12], 1: [12, 708] } },
  // А03 only ends at 707, so it must not count 707 as a boarding stop.
  { external_id: "3", short_name: "А03", stops_by_shape: { 0: [11, 707], 1: [707, 11] } },
  // Т09 serves 707's area only from «Руська» (~130 m), and reaches 12 fast.
  { external_id: "9", short_name: "Т09", stops_by_shape: { 0: [17, 12], 1: [12, 17] } },
  // А05 never comes near 707: reaching 22 takes a transfer at the 11/20 cluster.
  { external_id: "5", short_name: "А05", stops_by_shape: { 0: [20, 21, 22], 1: [22, 21, 20] } },
];

function collection(rows) {
  const matches = (row, query) =>
    Object.entries(query).every(([key, cond]) =>
      cond && typeof cond === "object" && "$in" in cond ? cond.$in.includes(row[key]) : row[key] === cond,
    );
  return {
    find: vi.fn((query = {}) => rows.filter((r) => matches(r, query))),
    findOne: vi.fn((query) => rows.find((r) => matches(r, query)) ?? null),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const stops = collection(STOPS);
  const routes = collection(ROUTES);
  db.getCollection.mockImplementation((name) => (name === "stops" ? stops : routes));
});

describe("searchStops", () => {
  it("matches Ukrainian and English names case-insensitively, prefix matches first", () => {
    expect(searchStops("ринок").map((s) => s.code)).toEqual([10]);
    expect(searchStops("rynok").map((s) => s.code)).toEqual([10]);
    expect(searchStops("ОПЕРА").map((s) => s.code)).toEqual([707, 708, 900, 14]);
    // Substring hit ranks below prefix hits.
    expect(searchStops("о").at(-1).code).not.toBe(707);
  });

  it("matches inflected names and every query word in any order", () => {
    // "опера" meets "опери" on the stem.
    expect(searchStops("театр опера").map((s) => s.code)).toEqual([14]);
    expect(searchStops("опера театр").map((s) => s.code)).toEqual([14]);
    expect(searchStops("ballet").map((s) => s.code)).toEqual([14]);
    // A whole-word hit outranks a mid-word one, even with a longer name.
    expect(searchStops("вокзал").map((s) => s.code)).toEqual([12, 16, 15]);
    // Short words are not stemmed, so "ринок" stays specific.
    expect(searchStops("ринок").map((s) => s.code)).toEqual([10]);
  });

  it("ignores apostrophe variants and caps results", () => {
    expect(searchStops("Марії'на").map((s) => s.code)).toEqual([13]);
    expect(searchStops("опера", 2)).toHaveLength(2);
    expect(searchStops("  ")).toEqual([]);
  });

  it("returns coordinates and deduplicated, sorted routes", () => {
    expect(searchStops("opera")[0]).toEqual({
      code: 707,
      name: "Опера",
      eng_name: "Opera",
      lat: 49.8437,
      lng: 24.0263,
      routes: ["А03", "Т01"],
    });
  });
});

describe("searchStops folding", () => {
  it("reads Latin look-alike letters typed in a Cyrillic name", () => {
    // Latin C and i, as typed with the layout switched mid-word.
    expect(searchStops("Cихiв").map((s) => s.code)).toEqual([22]);
    expect(searchStops("Пiдвальна").map((s) => s.code)).toEqual([11]);
  });

  it("ignores dots and dashes, so abbreviations still match", () => {
    expect(searchStops("пл. ринок").map((s) => s.code)).toEqual([10]);
    expect(searchStops("площа-ринок").map((s) => s.code)).toEqual([10]);
  });

  it("still matches English names typed in Latin", () => {
    expect(searchStops("rynok").map((s) => s.code)).toEqual([10]);
  });
});

describe("resolveRoute", () => {
  it("resolves Latin and Cyrillic short names to the display name with termini", () => {
    expect(resolveRoute("T1")).toEqual({
      external_id: "1",
      name: "Т01",
      destinations: ["Вокзал", "Опера"],
      stops: [[707, 10, 11, 12], [12, 11, 10, 707]],
    });
    expect(resolveRoute("Т01")?.name).toBe("Т01");
  });

  it("treats a bare number as an external ID", () => {
    expect(resolveRoute("2")?.name).toBe("Т02");
    expect(resolveRoute("99")).toBeNull();
  });
});

describe("listRouteNames", () => {
  it("returns every route's display name, sorted", () => {
    expect(listRouteNames()).toEqual(["А03", "А05", "Т01", "Т02", "Т09"]);
  });
});

describe("destinationsFor", () => {
  it("maps route and direction pairs to terminus names, skipping unknowns", () => {
    expect(
      destinationsFor([
        { routeId: "1", direction: 0 },
        { routeId: "1", direction: 1 },
        { routeId: "3", direction: null },
      ]),
    ).toEqual({ "1:0": "Вокзал", "1:1": "Опера" });
  });
});

describe("findRoutesBetween", () => {
  it("boards anywhere within a short walk and ranks by stops plus walking", () => {
    const result = findRoutesBetween(707, 12);

    expect(result.from.code).toBe(707);
    // Both platforms and the differently named stops nearby; not the far namesake.
    expect(result.from.codes).toEqual([14, 17, 707, 708]);
    expect(result.options.map((o) => [o.route, o.board_stop.code, o.stops_count])).toEqual([
      ["Т02", 708, 1],
      ["Т09", 17, 1],
      ["Т01", 707, 3],
    ]);
    expect(result.options[0]).toMatchObject({ direction: 0, destination: "Вокзал", walk_from_alight_meters: 0 });
    expect(result.options[0].walk_to_board_meters).toBeGreaterThan(0);
    expect(result.options[1].walk_to_board_meters).toBeGreaterThan(result.options[0].walk_to_board_meters);
    expect(result.options[2].walk_to_board_meters).toBe(0);
  });

  it("does not board at a terminus and respects direction", () => {
    // А03 dir 0 ends at 707, dir 1 starts there: only dir 1 goes 707 → 11.
    const options = findRoutesBetween(707, 11).options;
    expect(options.filter((o) => o.route === "А03")).toMatchObject([{ direction: 1, stops_count: 1 }]);
    expect(options.find((o) => o.route === "Т01")).toMatchObject({ direction: 0, stops_count: 2 });
  });

  it("reports the missing stop", () => {
    expect(findRoutesBetween(707, 404).missing).toBe(404);
  });

  it("offers one interchange within a stop cluster when there is no direct route", () => {
    const result = findRoutesBetween(707, 22);

    expect(result.options).toEqual([]);
    const best = result.transfer_options[0];
    // А03 is one stop to «Підвальна», Т01 two: the cheaper first leg wins.
    expect(best.legs.map((l) => [l.route, l.board_stop.code, l.alight_stop.code, l.stops_count])).toEqual([
      ["А03", 707, 11, 1],
      ["А05", 20, 22, 2],
    ]);
    expect(best.legs[1]).toMatchObject({ direction: 0, destination: "Сихів" });
    expect(best.transfer_walk_meters).toBeGreaterThan(0);
    expect(best.transfer_walk_meters).toBeLessThanOrEqual(TRANSFER_RADIUS_METERS);
    expect(best).toMatchObject({ stops_count: 3, walk_to_board_meters: 0, walk_from_alight_meters: 0 });
    expect(result.transfer_options.map((t) => t.legs.map((l) => l.route))).toContainEqual(["Т01", "А05"]);
    // Never more than one interchange.
    for (const option of result.transfer_options) expect(option.legs).toHaveLength(2);
  });

  it("does not list transfers that a direct route beats", () => {
    expect(findRoutesBetween(707, 12).transfer_options).toEqual([]);
  });

  it("answers a walk, not a ride, when the stops are a short walk apart", () => {
    // 707 → 707 used to come back with both lists empty, which reads as "needs two transfers".
    expect(findRoutesBetween(707, 707)).toMatchObject({ options: [], transfer_options: [], walk_meters: 0 });
    const across = findRoutesBetween(707, 708);
    expect(across.options).toEqual([]);
    expect(across.walk_meters).toBeGreaterThan(0);
    expect(across.walk_meters).toBeLessThanOrEqual(300);
    expect(findRoutesBetween(707, 12).walk_meters).toBeUndefined();
  });

  it("leaves out route and stop pairs the served filter rules out", () => {
    // Т02 suspended; Т09 detoured past «Руська» (17), so it cannot be boarded there.
    const served = (route, stop) => route !== "Т02" && !(route === "Т09" && stop === 17);
    expect(findRoutesBetween(707, 12, served).options.map((o) => o.route)).toEqual(["Т01"]);
  });

  it("starts from a point at every stop within a wider walk of it", () => {
    // ~25 m from 707: the walk is measured from the point, not from the nearest stop.
    const result = findRoutesBetween({ lat: 49.8435, lng: 24.0261 }, 12);
    expect(result.from.code).toBe(707);
    expect(result.options[0]).toMatchObject({ route: "Т02", board_stop: { code: 708 } });
    expect(result.options.find((o) => o.route === "Т01").walk_to_board_meters).toBeGreaterThan(0);
    expect(POINT_WALK_RADIUS_METERS).toBeGreaterThan(300);
  });

  it("reports which point has no stop within walking distance", () => {
    expect(findRoutesBetween({ lat: 50.5, lng: 25.5 }, 12).missing).toBe("from");
    expect(findRoutesBetween(707, { lat: 50.5, lng: 25.5 }).missing).toBe("to");
  });

  it("answers a walk between two points a short walk apart", () => {
    const result = findRoutesBetween({ lat: 49.8435, lng: 24.0261 }, { lat: 49.8440, lng: 24.0268 });
    expect(result.walk_meters).toBeGreaterThan(0);
    expect(result.options).toEqual([]);
  });

  it("names each leg's GTFS route id, for timetable lookups", () => {
    expect(findRoutesBetween(707, 12).options.map((o) => [o.route, o.route_id])).toEqual([
      ["Т02", "2"],
      ["Т09", "9"],
      ["Т01", "1"],
    ]);
    expect(findRoutesBetween(707, 22).transfer_options[0].legs.map((l) => l.route_id)).toEqual(["3", "5"]);
  });

  it("does not transfer outside the walking cluster", () => {
    // 21 is ~1.9 km from anything on the 707 lines; only the 11/20 cluster connects them.
    const pairs = findRoutesBetween(707, 22).transfer_options.map((t) => [t.legs[0].alight_stop.code, t.legs[1].board_stop.code]);
    for (const [alight, board] of pairs) expect([[11, 20]]).toContainEqual([alight, board]);
  });
});

describe("nextStopsForVehicles", () => {
  it("returns the first stop still ahead of each vehicle", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const at = (minutes) => ({ time: String((now + minutes * 60_000) / 1000) });
    getArrivalTimes.mockResolvedValue([
      {
        tripUpdate: {
          vehicle: { id: "V1" },
          stopTimeUpdate: [
            { stopId: "MG11", stopSequence: 3, arrival: at(4) },
            { stopId: "MG10", stopSequence: 2, arrival: at(-2) },
          ],
        },
      },
      { tripUpdate: { vehicle: { id: "OTHER" }, stopTimeUpdate: [{ stopId: "MG12", stopSequence: 1, arrival: at(1) }] } },
    ]);

    expect(await nextStopsForVehicles(["V1"], now)).toEqual({
      V1: { code: 11, name: "Підвальна", arrival: "2026-01-01T12:04:00.000Z" },
    });
  });

  it("takes the soonest stop across the current and the next trip", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const at = (minutes) => ({ time: String((now + minutes * 60_000) / 1000) });
    getArrivalTimes.mockResolvedValue([
      // The next trip comes first in the feed but starts later.
      { tripUpdate: { vehicle: { id: "V1" }, stopTimeUpdate: [{ stopId: "MG12", stopSequence: 99, arrival: at(40) }] } },
      { tripUpdate: { vehicle: { id: "V1" }, stopTimeUpdate: [{ stopId: "MG10", stopSequence: 1, departure: at(3) }] } },
    ]);

    expect((await nextStopsForVehicles(["V1"], now)).V1.code).toBe(10);
  });

  it("lists every stop still ahead, soonest first, across trips", async () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const at = (minutes) => ({ time: String((now + minutes * 60_000) / 1000) });
    getArrivalTimes.mockResolvedValue([
      { tripUpdate: { vehicle: { id: "V1" }, stopTimeUpdate: [{ stopId: "MG12", arrival: at(40) }, { stopId: "MGNOPE", arrival: at(1) }] } },
      { tripUpdate: { vehicle: { id: "V1" }, stopTimeUpdate: [{ stopId: "MG11", arrival: at(7) }, { stopId: "MG10", arrival: at(-5) }] } },
    ]);
    const etas = await etasForVehicles(["V1"], now);
    // Passed stops and stops missing from the timetable are dropped.
    expect(etas.V1.map((e) => [e.code, (e.time - now) / 60_000])).toEqual([
      [11, 7],
      [12, 40],
    ]);
  });

  it("skips the feed entirely when there are no vehicles", async () => {
    expect(await nextStopsForVehicles([])).toEqual({});
    expect(getArrivalTimes).not.toHaveBeenCalled();
  });
});
