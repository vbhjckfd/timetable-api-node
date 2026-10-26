import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("gtfs", () => ({
  getCalendars: vi.fn(),
  getTrips: vi.fn(),
  getShapes: vi.fn(),
}));

import {
  escapeHtml,
  distanceMeters,
  normalizeRouteName,
  normalizeRouteNameBase,
  routeNameToUrlFriendly,
  getRouteType,
  getRouteColor,
  getRouteTextColor,
  secondsUntilImportDone,
  formatRouteName,
  cleanUpStopName,
  getTextWaitTime,
  getDirectionByTrip,
  sortedShapeIds,
  shapes_by_direction,
  getAllServiceIds,
  getServiceDayCounts,
  getMostPopularShapes,
  getRouteTrips,
  assignTripDirections,
  getSmapleTrips,
} from "../../utils/appHelpers.js";
import { getCalendars, getShapes, getTrips } from "gtfs";

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });
  it("escapes double quotes", () => {
    expect(escapeHtml('"quoted"')).toBe("&quot;quoted&quot;");
  });
  it("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
  it("coerces non-strings", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("distanceMeters", () => {
  it("returns ~0 for identical coordinates", () => {
    expect(distanceMeters(49.0, 24.0, 49.0, 24.0)).toBeCloseTo(0);
  });
  it("returns positive distance between two points", () => {
    const d = distanceMeters(49.8397, 24.0297, 49.8425, 24.0311);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(500);
  });
  it("returns ~111km per degree of latitude", () => {
    const d = distanceMeters(0, 0, 1, 0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe("normalizeRouteName", () => {
  it("normalizes bus route", () => {
    expect(normalizeRouteName("А1")).toBe("А01");
    expect(normalizeRouteName("А10")).toBe("А10");
  });
  it("normalizes tram route (number < 20)", () => {
    expect(normalizeRouteName("Т1")).toBe("Т01");
    expect(normalizeRouteName("Т6")).toBe("Т06");
  });
  it("normalizes trolley route (number >= 20)", () => {
    expect(normalizeRouteName("Т22")).toBe("Тр22");
  });
  it("normalizes night bus route", () => {
    expect(normalizeRouteName("Н5")).toBe("Н-А05");
  });
  it("maps real-world A08a bus line to canonical A08 (А08)", () => {
    expect(normalizeRouteName("А8а")).toBe("А08");
    expect(normalizeRouteName("A08a")).toBe("А08");
  });
});

describe("normalizeRouteNameBase", () => {
  it("preserves A08a variant suffix for GTFS import vs plain A08", () => {
    expect(normalizeRouteNameBase("A08")).toBe("А08");
    expect(normalizeRouteNameBase("A08a")).toBe("А08a");
    expect(normalizeRouteNameBase("А8а")).toBe("А08a");
  });
});

describe("routeNameToUrlFriendly", () => {
  it("converts Тр trolley prefix to T", () => {
    expect(routeNameToUrlFriendly("Т22")).toBe("T22");
  });
  it("converts Т tram prefix to T", () => {
    expect(routeNameToUrlFriendly("Т01")).toBe("T01");
  });
  it("converts А bus prefix to A", () => {
    expect(routeNameToUrlFriendly("А01")).toBe("A01");
  });
  it("maps A08a-style input to A08 URL segment", () => {
    expect(routeNameToUrlFriendly("А08a")).toBe("A08");
    expect(routeNameToUrlFriendly("A08a")).toBe("A08");
  });
});

describe("getRouteType", () => {
  it("returns bus for bus routes", () => {
    expect(getRouteType("А01")).toBe("bus");
  });
  it("returns tram for tram routes", () => {
    expect(getRouteType("Т01")).toBe("tram");
  });
  it("returns trolleybus for trolleybus routes", () => {
    expect(getRouteType("Тр22")).toBe("trolleybus");
  });
});

describe("getRouteColor", () => {
  it("returns a hex color for a known tram route", () => {
    const color = getRouteColor("Т01");
    expect(color).toBe("#E42D24");
  });
  it("returns black for night bus", () => {
    expect(getRouteColor("Н-А01")).toBe("#000000");
  });
  it("returns default color for bus route", () => {
    expect(getRouteColor("А01")).toBe("#0E4F95");
  });
  it("returns colours for Т38 and Т08", () => {
    expect(getRouteColor("Тр38")).toBe("#9B0A00");
    expect(getRouteColor("Т08")).toBe("#919191");
  });
  it("falls back to the default color for a tram/trolleybus line missing from the map", () => {
    expect(getRouteColor("Тр26")).toBe("#0E4F95");
    expect(getRouteColor("Т10")).toBe("#0E4F95");
  });
});

describe("getRouteTextColor", () => {
  it("returns black on the pale trolleybus lines", () => {
    expect(getRouteTextColor("Тр24")).toBe("#000000");
    expect(getRouteTextColor("Тр27")).toBe("#000000");
    expect(getRouteTextColor("Тр30")).toBe("#000000");
  });
  it("returns white elsewhere", () => {
    expect(getRouteTextColor("Тр38")).toBe("#FFFFFF");
    expect(getRouteTextColor("Т08")).toBe("#FFFFFF");
    expect(getRouteTextColor("А24")).toBe("#FFFFFF");
    expect(getRouteTextColor("Н-А30")).toBe("#FFFFFF");
  });
});

describe("formatRouteName", () => {
  it("replaces Тр prefix with Т", () => {
    expect(formatRouteName("Тр22")).toBe("Т22");
  });
  it("replaces Н-А prefix with Н", () => {
    expect(formatRouteName("Н-А01")).toBe("Н01");
  });
  it("strips trailing -А suffix", () => {
    expect(formatRouteName("А08-А")).toBe("А08");
  });
  it("strips trailing lowercase а", () => {
    expect(formatRouteName("А08а")).toBe("А08");
  });
  it("strips trailing latin a used in stored short_name", () => {
    expect(formatRouteName("А08a")).toBe("А08");
  });
});

describe("cleanUpStopName", () => {
  it("removes parenthesized number codes from stop names", () => {
    expect(cleanUpStopName("Площа Ринок (-1234)")).toBe("Площа Ринок");
  });
  it("passes through names without codes", () => {
    expect(cleanUpStopName("Площа Ринок")).toBe("Площа Ринок");
  });
});

describe("getTextWaitTime", () => {
  it("shows minutes left when arrival is in future", () => {
    const future = new Date(Date.now() + 3 * 60 * 1000);
    expect(getTextWaitTime(future)).toBe("3хв");
  });
  it("shows < 1 when arrival is in the past or immediate", () => {
    const past = new Date(Date.now() - 10000);
    expect(getTextWaitTime(past)).toBe("< 1хв");
  });
});

describe("getDirectionByTrip", () => {
  const route = {
    trip_shape_map: { "trip-1": "shape-a", "trip-2": "shape-b" },
    shapes: { "shape-a": {}, "shape-b": {} },
  };
  it("returns null for unknown trip", () => {
    expect(getDirectionByTrip(null, route)).toBeNull();
    expect(getDirectionByTrip("trip-99", route)).toBeNull();
  });
  it("returns index of shape in sorted shapes", () => {
    expect(getDirectionByTrip("trip-1", route)).toBe(0);
    expect(getDirectionByTrip("trip-2", route)).toBe(1);
  });
  it("returns null when the trip's shape has no geometry", () => {
    expect(
      getDirectionByTrip("trip-3", {
        trip_shape_map: { "trip-3": "shape-missing" },
        shapes: { "shape-a": {} },
      }),
    ).toBeNull();
  });
});

describe("sortedShapeIds", () => {
  it("orders numeric shape ids numerically, not lexicographically", () => {
    expect(sortedShapeIds({ shapes: { 11850: [], 9999: [], 11849: [] } })).toEqual(
      ["9999", "11849", "11850"],
    );
  });
  it("falls back to string order for non-numeric ids", () => {
    expect(sortedShapeIds({ shapes: { "shape-b": [], "shape-a": [] } })).toEqual([
      "shape-a",
      "shape-b",
    ]);
  });
  it("tolerates a route with no shapes", () => {
    expect(sortedShapeIds({})).toEqual([]);
  });
});

describe("shapes_by_direction", () => {
  // Regression: shape_direction_map used to hold the GTFS direction_id, which on
  // 27 of 69 Lviv routes runs opposite to shape order. Each direction then drew
  // the other direction's polyline next to its own stop list (route А15).
  it("pairs each direction with the shape getDirectionByTrip assigns to it", () => {
    const route = {
      trip_shape_map: { "trip-a": "11849", "trip-b": "11850" },
      shapes: { 11849: [[49.82, 24.08]], 11850: [[49.83, 23.99]] },
      shape_direction_map: { 11849: 0, 11850: 1 },
    };

    const shapes = shapes_by_direction(route);
    expect(shapes[getDirectionByTrip("trip-a", route)]).toBe(route.shapes[11849]);
    expect(shapes[getDirectionByTrip("trip-b", route)]).toBe(route.shapes[11850]);
  });
});

describe("secondsUntilImportDone", () => {
  it("counts to today's 01:15 UTC when it is still ahead", () => {
    // 00:30 UTC: today's import is 45 min away.
    expect(secondsUntilImportDone(new Date("2026-10-04T00:30:00Z"))).toBe(45 * 60);
  });

  it("counts to tomorrow's 01:15 UTC once today's has passed", () => {
    expect(secondsUntilImportDone(new Date("2026-10-04T01:15:00Z"))).toBe(24 * 3600);
  });

  it("is not thrown a day late by the local date running ahead of UTC", () => {
    // 22:30 UTC on the 3rd is 01:30 on the 4th in Kyiv.
    expect(secondsUntilImportDone(new Date("2026-10-03T22:30:00Z"))).toBe(2 * 3600 + 45 * 60);
  });
});

describe("import trip lookups span every service day", () => {
  const calendar = (service_id, days) => ({
    service_id,
    ...Object.fromEntries(
      ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, days.includes(d) ? 1 : 0]),
    ),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getCalendars.mockResolvedValue([
      calendar("WD", ["monday", "tuesday", "wednesday", "thursday", "friday"]),
      calendar("SAT", ["saturday"]),
      calendar("SUN", ["sunday"]),
      // Only runs on calendar_dates exceptions: no weekday of its own.
      calendar("XMAS", []),
    ]);
    getShapes.mockResolvedValue([{ shape_id: "S0" }, { shape_id: "S1" }, { shape_id: "WKND" }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the days a week each running service covers", async () => {
    expect(await getServiceDayCounts()).toEqual({ WD: 5, SAT: 1, SUN: 1 });
    expect(await getAllServiceIds()).toEqual(["WD", "SAT", "SUN"]);
  });

  it("picks the same shapes whatever day the import runs, weighting trips by service days", async () => {
    getTrips.mockResolvedValue([
      // Two weekend trips on WKND, one workday trip on S0: over a week S0 runs 5 times, WKND 4.
      { shape_id: "S0", direction_id: 0, service_id: "WD" },
      { shape_id: "WKND", direction_id: 0, service_id: "SAT" },
      { shape_id: "WKND", direction_id: 0, service_id: "SAT" },
      { shape_id: "WKND", direction_id: 0, service_id: "SUN" },
      { shape_id: "WKND", direction_id: 0, service_id: "SUN" },
      { shape_id: "S1", direction_id: 1, service_id: "WD" },
    ]);
    // A Sunday-night build used to see Sunday's trips only, and the deployed
    // data then knew no Monday trip until the next rebuild.
    for (const day of ["2026-10-25T21:55:00Z", "2026-10-26T09:00:00Z"]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(day));
      expect(await getMostPopularShapes("R1")).toEqual(["S0", "S1"]);
      expect(getTrips).toHaveBeenLastCalledWith(
        { route_id: "R1", service_id: ["WD", "SAT", "SUN"] },
        ["shape_id", "direction_id", "service_id"],
      );
      vi.useRealTimers();
    }
  });

  it("fetches every trip of a route on the given services", async () => {
    getTrips.mockResolvedValueOnce([{ trip_id: "mon-1", shape_id: "S0", direction_id: 0 }]);
    expect(await getRouteTrips("R1", ["WD", "SUN"])).toHaveLength(1);
    expect(getTrips).toHaveBeenCalledWith({ route_id: "R1", service_id: ["WD", "SUN"] }, ["trip_id", "direction_id", "shape_id"]);
  });
});

describe("assignTripDirections", () => {
  // Shape order gives S0 direction 0 and S1 direction 1; GTFS direction_id runs the other way.
  const route = {
    shapes: { S0: [], S1: [] },
    trip_shape_map: { a: "S0", b: "S1", shortTurn: "S9", bare: "S9", noGtfs: "S9" },
  };

  it("uses shape order for trips on the route's shapes", () => {
    const dirs = assignTripDirections(
      [{ trip_id: "a", shape_id: "S0", direction_id: 1 }, { trip_id: "b", shape_id: "S1", direction_id: 0 }],
      route,
    );
    expect(dirs).toEqual({ a: 0, b: 1 });
  });

  it("translates an off-shape trip's GTFS direction through the on-shape trips", () => {
    const dirs = assignTripDirections(
      [
        { trip_id: "a", shape_id: "S0", direction_id: 1 },
        { trip_id: "b", shape_id: "S1", direction_id: 0 },
        // GTFS 1 is shape direction 0 on this route, not 1.
        { trip_id: "shortTurn", shape_id: "S9", direction_id: 1 },
        { trip_id: "noGtfs", shape_id: "S9", direction_id: null },
      ],
      route,
    );
    expect(dirs.shortTurn).toBe(0);
    expect(dirs).not.toHaveProperty("noGtfs");
  });

  it("falls back to the raw GTFS direction when nothing can translate it", () => {
    expect(assignTripDirections([{ trip_id: "bare", shape_id: "S9", direction_id: 1 }], route)).toEqual({ bare: 1 });
  });
});

describe("getSmapleTrips", () => {
  it("samples stop sequences from trips on the route's own shapes", () => {
    const route = {
      shapes: { S0: [], S1: [] },
      trip_shape_map: { full0: "S0", short0: "S9", full1: "S1" },
      // The short-turn comes last, so an unfiltered pick would take it.
      trip_direction_map: { full0: 0, full1: 1, short0: 0 },
    };
    expect(getSmapleTrips(route)).toEqual(["full0", "full1"]);
  });

  it("uses any trip when none runs on the route's shapes", () => {
    expect(getSmapleTrips({ trip_direction_map: { x: 0, y: 1 } })).toEqual(["x", "y"]);
  });
});
