import { describe, it, expect, vi, beforeEach } from "vitest";

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
  formatRouteName,
  cleanUpStopName,
  getTextWaitTime,
  getDirectionByTrip,
} from "../../utils/appHelpers.js";

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
  it("returns trol for trolleybus routes", () => {
    expect(getRouteType("Тр22")).toBe("trol");
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
});
