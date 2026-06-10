import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  __getCached,
  __setCached,
  __resetToolCache,
  __toolCacheSize,
  TOOL_CACHE_MAX_ENTRIES,
} from "../../mcp/timetableMcpServer.js";

beforeEach(() => {
  vi.restoreAllMocks();
  __resetToolCache();
});

describe("MCP tool cache", () => {
  it("returns cached values within TTL and expires them after", () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);

    __setCached("get_vehicle_info", { vehicle_id: "V1" }, { hit: true });
    expect(__getCached("get_vehicle_info", { vehicle_id: "V1" })).toEqual({ hit: true });

    nowSpy.mockReturnValue(base + 5_001); // get_vehicle_info TTL is 5s
    expect(__getCached("get_vehicle_info", { vehicle_id: "V1" })).toBeNull();
  });

  it("caps total entries even for never-repeated keys", () => {
    // Coordinate-keyed tools produce keys that essentially never repeat;
    // without a cap the map grows for the lifetime of the process.
    for (let i = 0; i < TOOL_CACHE_MAX_ENTRIES * 2; i++) {
      __setCached(
        "get_nearby_vehicles",
        { latitude: 49 + i / 10_000, longitude: 24.03 },
        { i },
      );
    }
    expect(__toolCacheSize()).toBeLessThanOrEqual(TOOL_CACHE_MAX_ENTRIES);
  });

  it("prefers evicting expired entries over live ones when full", () => {
    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(base);

    // Fill to capacity with short-TTL entries (get_vehicle_info: 5s)
    for (let i = 0; i < TOOL_CACHE_MAX_ENTRIES; i++) {
      __setCached("get_vehicle_info", { vehicle_id: `V${i}` }, { i });
    }
    // One live long-TTL entry on top (get_route_static: 5min) — inserted last
    nowSpy.mockReturnValue(base + 10_000); // short-TTL entries are now expired
    __setCached("get_route_static", { route_name: "T30" }, { keep: true });

    expect(__toolCacheSize()).toBeLessThanOrEqual(TOOL_CACHE_MAX_ENTRIES);
    expect(__getCached("get_route_static", { route_name: "T30" })).toEqual({ keep: true });
    expect(__getCached("get_vehicle_info", { vehicle_id: "V0" })).toBeNull();
  });
});
