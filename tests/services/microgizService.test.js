import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const metrics = vi.hoisted(() => ({
  count: vi.fn(),
  distribution: vi.fn(),
  annotate: vi.fn(),
  event: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("../../utils/metrics.js", () => metrics);

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
  __resetVehiclesCache,
  __resetArrivalsCache,
} from "../../services/microgizService.js";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  __resetVehiclesCache();
  __resetArrivalsCache();
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
      headers: { get: vi.fn().mockReturnValue("8") },
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

  it("retries then rejects when the body is truncated vs Content-Length", async () => {
    // Body is 8 bytes but the server claims 12 → every attempt is truncated.
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("12") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    await expect(getVehiclesLocations()).rejects.toThrow(/Truncated response/);
    // never hands a short buffer to the decoder
    expect(
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode,
    ).not.toHaveBeenCalled();
  });

  it("rejects when all retries fail", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // fetchPlus exhausts retries and its .catch() returns undefined;
    // the subsequent .then(r => r.arrayBuffer()) then throws on undefined
    await expect(getVehiclesLocations()).rejects.toThrow();
  });

  it("serves the cached feed when a later fetch fails within the stale window", async () => {
    const mockEntities = [{ id: "cached" }];
    // 1) a good fetch populates the cache
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });
    expect(await getVehiclesLocations()).toEqual(mockEntities);

    // 2) past the serve-stale window, every attempt fails → fall back to the cache
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await getVehiclesLocations()).toEqual(mockEntities);
  });

  it("rethrows when the cached feed is older than the stale window", async () => {
    const mockEntities = [{ id: "old" }];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });
    expect(await getVehiclesLocations()).toEqual(mockEntities);

    // advance past the 3 min stale window, then make every attempt fail
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60 * 1000 + 1);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getVehiclesLocations()).rejects.toThrow();
  });
});

describe("getArrivalTimes", () => {
  it("returns decoded GTFS-RT entities", async () => {
    const mockEntities = [{ id: "e1" }];
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });

    const result = await getArrivalTimes();

    expect(result).toEqual(mockEntities);
  });

  it("retries once when the first attempt is truncated", async () => {
    const mockEntities = [{ id: "e1" }];
    // 1st attempt: 8 bytes delivered, 12 promised → truncated
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("12") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    // 2nd attempt: complete body
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });

    expect(await getArrivalTimes()).toEqual(mockEntities);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when the first attempt fails to decode", async () => {
    const mockEntities = [{ id: "e1" }];
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode
      .mockImplementationOnce(() => {
        throw new Error("index out of range");
      })
      .mockReturnValue({ entity: mockEntities });

    expect(await getArrivalTimes()).toEqual(mockEntities);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves the cached feed when a later fetch fails within the stale window", async () => {
    const mockEntities = [{ id: "cached" }];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });
    expect(await getArrivalTimes()).toEqual(mockEntities);

    // past the serve-stale window, every attempt fails → fall back to the cache
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await getArrivalTimes()).toEqual(mockEntities);
  });

  it("rethrows when the cached feed is older than the stale window", async () => {
    const mockEntities = [{ id: "old" }];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn().mockReturnValue("8") },
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      entity: mockEntities,
    });
    expect(await getArrivalTimes()).toEqual(mockEntities);

    // advance past the 60s stale window, then make every attempt fail
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 1000 + 1);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(getArrivalTimes()).rejects.toThrow();
  });
});

describe("feed reuse", () => {
  const okResponse = () => ({
    ok: true,
    headers: { get: vi.fn().mockReturnValue("8") },
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  });

  it.each([
    ["getVehiclesLocations", getVehiclesLocations],
    ["getArrivalTimes", getArrivalTimes],
  ])("%s reuses a fetch younger than 5s", async (_name, get) => {
    fetchMock.mockImplementation(async () => okResponse());
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({ entity: [{ id: "a" }] });

    await get();
    await get();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
    await get();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["getVehiclesLocations", getVehiclesLocations],
    ["getArrivalTimes", getArrivalTimes],
  ])("%s serves a 5-8s old copy at once and refreshes it in the background", async (_name, get) => {
    const decode = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode;
    fetchMock.mockImplementation(async () => okResponse());
    decode.mockReturnValue({ entity: [{ id: "old" }] });
    await get();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 7_000);
    let release;
    fetchMock.mockImplementation(() => new Promise((r) => (release = r)));

    // The download hangs, yet requests are answered from the old copy.
    expect(await get()).toEqual([{ id: "old" }]);
    expect(await get()).toEqual([{ id: "old" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    decode.mockReturnValue({ entity: [{ id: "new" }] });
    release(okResponse());
    await vi.waitFor(async () => expect(await get()).toEqual([{ id: "new" }]));
  });

  it.each([
    ["getVehiclesLocations", getVehiclesLocations],
    ["getArrivalTimes", getArrivalTimes],
  ])("%s waits for a download once the copy is older than 8s", async (_name, get) => {
    const decode = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode;
    fetchMock.mockImplementation(async () => okResponse());
    decode.mockReturnValue({ entity: [{ id: "old" }] });
    await get();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8_001);
    decode.mockReturnValue({ entity: [{ id: "new" }] });
    expect(await get()).toEqual([{ id: "new" }]);
  });

  it("passes a keep-alive dispatcher to fetch", async () => {
    fetchMock.mockImplementation(async () => okResponse());
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({ entity: [] });
    await getArrivalTimes();
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it.each([
    ["getVehiclesLocations", getVehiclesLocations],
    ["getArrivalTimes", getArrivalTimes],
  ])("%s shares one download between concurrent callers", async (_name, get) => {
    fetchMock.mockImplementation(async () => okResponse());
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({ entity: [{ id: "a" }] });

    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does not keep a failed download for the next caller", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(getArrivalTimes()).rejects.toThrow();

    fetchMock.mockImplementation(async () => okResponse());
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({ entity: [{ id: "b" }] });
    expect(await getArrivalTimes()).toEqual([{ id: "b" }]);
  });
});

describe("feed freshness", () => {
  const response = (headers) => ({
    ok: true,
    headers: { get: (name) => headers[name] ?? null },
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  });

  it("records the edge, publish and fix ages of a vehicle download", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const sec = now / 1000;
    fetchMock.mockResolvedValue(
      response({ "content-length": "8", age: "4", "cf-cache-status": "HIT" }),
    );
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      header: { timestamp: sec - 7 },
      entity: [
        { id: "a", vehicle: { timestamp: sec - 30 } },
        { id: "b", vehicle: { timestamp: sec - 12 } },
        { id: "c", vehicle: { timestamp: sec - 9 } },
        { id: "d", vehicle: {} },
      ],
    });

    await getVehiclesLocations();

    expect(metrics.event).toHaveBeenCalledWith(
      "FeedFetch",
      expect.objectContaining({
        feed: "vehicle_positions",
        entities: 4,
        cacheStatus: "HIT",
        edgeAgeSec: 4,
        headerAgeSec: 7,
        newestFixAgeSec: 9,
        medianFixAgeSec: 12,
      }),
    );
  });

  it("reads trip update timestamps and marks missing fields as -1", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    fetchMock.mockResolvedValue(response({ "content-length": "8" }));
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({
      header: {},
      entity: [{ id: "t", tripUpdate: { timestamp: now / 1000 - 5 } }],
    });

    await getArrivalTimes();

    expect(metrics.event).toHaveBeenCalledWith(
      "FeedFetch",
      expect.objectContaining({
        feed: "trip_updates",
        cacheStatus: "",
        edgeAgeSec: -1,
        headerAgeSec: -1,
        newestFixAgeSec: 5,
        medianFixAgeSec: 5,
      }),
    );
  });

  it("tags the transaction with the age of the copy it used", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    fetchMock.mockResolvedValue(response({ "content-length": "8" }));
    GtfsRealtimeBindings.transit_realtime.FeedMessage.decode.mockReturnValue({ entity: [] });

    await getArrivalTimes();
    expect(metrics.annotate).toHaveBeenLastCalledWith({ tripUpdatesCacheAgeMs: 0 });

    now.mockReturnValue(1_800_000_003_000);
    await getArrivalTimes();
    expect(metrics.annotate).toHaveBeenLastCalledWith({ tripUpdatesCacheAgeMs: 3_000 });
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
