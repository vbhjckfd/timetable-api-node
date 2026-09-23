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
  nextStopsForVehicles,
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

describe("resolveRoute", () => {
  it("resolves Latin and Cyrillic short names to the display name with termini", () => {
    expect(resolveRoute("T1")).toEqual({ external_id: "1", name: "Т01", destinations: ["Вокзал", "Опера"] });
    expect(resolveRoute("Т01")?.name).toBe("Т01");
  });

  it("treats a bare number as an external ID", () => {
    expect(resolveRoute("2")?.name).toBe("Т02");
    expect(resolveRoute("99")).toBeNull();
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

  it("skips the feed entirely when there are no vehicles", async () => {
    expect(await nextStopsForVehicles([])).toEqual({});
    expect(getArrivalTimes).not.toHaveBeenCalled();
  });
});
