import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("gtfs-realtime-bindings", () => ({
  default: {
    transit_realtime: {
      FeedMessage: {
        decode: vi.fn(),
      },
    },
  },
}));

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  getTimeOfLastStaticUpdate,
  getVehiclesLocations,
  getArrivalTimes,
  routesThroughStop,
} from "../../services/microgizService.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getTimeOfLastStaticUpdate", () => {
  it("returns a Date parsed from the last-modified header", async () => {
    const lastModified = "Mon, 06 Apr 2026 10:00:00 GMT";
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue(lastModified) },
    });

    const result = await getTimeOfLastStaticUpdate();

    expect(result).toBeInstanceOf(Date);
    expect(result.toUTCString()).toBe(lastModified);
  });
});

describe("getVehiclesLocations", () => {
  it("returns decoded GTFS-RT entities", async () => {
    const mockEntities = [{ id: "v1" }, { id: "v2" }];
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });

    const result = await getVehiclesLocations();

    expect(result).toEqual(mockEntities);
    expect(
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode,
    ).toHaveBeenCalled();
  });

  it("rejects when all retries fail", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // fetchPlus exhausts retries and its .catch() returns undefined;
    // the subsequent .then(r => r.arrayBuffer()) then throws on undefined
    await expect(getVehiclesLocations()).rejects.toThrow();
  });
});

describe("getArrivalTimes", () => {
  it("returns decoded GTFS-RT entities", async () => {
    const mockEntities = [{ id: "e1" }];
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });

    const result = await getArrivalTimes();

    expect(result).toEqual(mockEntities);
  });
});

describe("routesThroughStop", () => {
  const stopCode = 1001;

  const mockRoute = {
    external_id: "EXT1",
    short_name: "А01",
    stops_by_shape: {
      0: [stopCode, 1002, 1003], // stop is not last (slice removes last)
      1: [1003, 1002, stopCode + 1], // stop not here
    },
    shape_direction_map: { SHAPE1: "0" },
  };

  const mockStop = {
    code: stopCode,
    name: "Test Stop",
    eng_name: "Test Stop EN",
  };
  const endStop = { code: 1003, name: "End Stop", eng_name: "End Stop EN" };

  function makeRoutesCollection(routes) {
    return { find: vi.fn().mockReturnValue(routes) };
  }

  function makeStopsCollection(stops) {
    return {
      findOne: vi
        .fn()
        .mockImplementation(
          (q) => stops.find((s) => s.code === q.code) ?? null,
        ),
    };
  }

  it("returns routes that include the stop in direction 0", async () => {
    const result = await routesThroughStop(
      mockStop,
      makeRoutesCollection([mockRoute]),
      makeStopsCollection([mockStop, endStop]),
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("EXT1");
    expect(result[0].direction_id).toBe(0);
  });

  it("returns empty array when stop is not in any route", async () => {
    const unrelatedRoute = {
      ...mockRoute,
      stops_by_shape: { 0: [9999, 9998, 9997], 1: [9997, 9998, 9999] },
    };

    const result = await routesThroughStop(
      mockStop,
      makeRoutesCollection([unrelatedRoute]),
      makeStopsCollection([]),
    );

    expect(result).toHaveLength(0);
  });

  it("ignores the last stop in each direction when matching", async () => {
    // stop is ONLY at the last position (excluded by slice(0, -1))
    const routeWithStopLast = {
      ...mockRoute,
      stops_by_shape: {
        0: [9999, stopCode], // stopCode is last → excluded
        1: [9998, 9997],
      },
    };

    const result = await routesThroughStop(
      mockStop,
      makeRoutesCollection([routeWithStopLast]),
      makeStopsCollection([]),
    );

    expect(result).toHaveLength(0);
  });

  it("sorts results by route name", async () => {
    const routeB = {
      external_id: "EXT2",
      short_name: "А03",
      stops_by_shape: { 0: [stopCode, 2001, 2002], 1: [2002, 2001, 9999] },
      shape_direction_map: { SHAPE2: "0" },
    };
    const routeA = {
      external_id: "EXT1",
      short_name: "А01",
      stops_by_shape: { 0: [stopCode, 1002, 1003], 1: [1003, 1002, 9999] },
      shape_direction_map: { SHAPE1: "0" },
    };

    const stopsCol = makeStopsCollection([
      { code: 1003, name: "End 1", eng_name: "End 1" },
      { code: 2002, name: "End 2", eng_name: "End 2" },
    ]);

    const result = await routesThroughStop(
      mockStop,
      makeRoutesCollection([routeB, routeA]),
      stopsCol,
    );

    expect(result.map((r) => r.id)).toEqual(["EXT1", "EXT2"]);
  });
});
