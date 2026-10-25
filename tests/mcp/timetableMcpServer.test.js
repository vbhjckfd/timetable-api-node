import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

vi.mock("../../actions/getSingleStopAction.js", () => ({
  default: async (req, res) => {
    if (req.stopCode === 404404) return res.status(404).send(`Bad argument, stop with code ${req.stopCode} not found`);
    if (req.stopCode === 505) {
      return res.json({
        code: 505, name: "Mixed Stop", latitude: 49.84, longitude: 24.02, transfers: [],
        timetable: [
          { route: "Т01", end_stop: "Вокзал", vehicle_type: "tram", time_left: "2 хв", vehicle_id: "old-1", lowfloor: false },
          { route: "Т01", end_stop: "Вокзал", vehicle_type: "tram", time_left: "6 хв", vehicle_id: "new-1", lowfloor: true },
          // Timetable entries always say lowfloor: false; that is not a fact about any vehicle.
          { route: "Т01", end_stop: "Вокзал", vehicle_type: "tram", time_left: "20 хв", lowfloor: false, scheduled: true },
        ],
      });
    }
    if (req.stopCode === 708) {
      return res.json({
        code: 708, name: "Опера", latitude: 49.844, longitude: 24.0268, transfers: [],
        timetable: [
          { route: "Т01", end_stop: "Вокзал", direction: 0, time_left: "3 хв", vehicle_id: "t1-a", lowfloor: true },
          { route: "Т01", end_stop: "Опера", direction: 1, time_left: "1 хв", vehicle_id: "t1-back", lowfloor: false },
          { route: "Т02", end_stop: "Вокзал", direction: 0, time_left: "2 хв", vehicle_id: "t2", lowfloor: false },
          { route: "Т01", end_stop: "Вокзал", direction_id: 0, time_left: "15 хв", lowfloor: false, scheduled: true },
        ],
      });
    }
    if (req.stopCode === 303) {
      // A scheduled arrival with no time the parser can read.
      return res.json({ code: 303, name: "No ETA Stop", latitude: 49.84, longitude: 24.02, transfers: [], timetable: [{ route: "Т01", end_stop: "Сихів", vehicle_type: "tram" }] });
    }
    const includeTimetable = req.query.skipTimetableData === "false";
    res.json({
      code: req.stopCode,
      name: "Mock Stop",
      latitude: 49.84,
      longitude: 24.02,
      transfers: [{ route: "1A" }],
      timetable: includeTimetable
        ? [
            {
              route: "1A",
              direction: "Center",
              vehicle_type: "bus",
              time_left: "5 хв",
              vehicle_id: "vehicle-1",
              location: [49.841, 24.021],
              bearing: 120,
            },
          ]
        : [],
    });
  },
}));

vi.mock("../../actions/routeStaticInfoAction.js", () => ({
  default: async (req, res) => {
    if (req.params.name === "NOPE") return res.sendStatus(404);
    res.json({
      route_short_name: req.params.name,
      route_long_name: "Mock Long Name",
      color: "#FF0000",
      type: "tram",
      stops: [
        [{ code: 101, name: "First", loc: [49.84, 24.02], departures: ["05:30"], schedule: { workday: ["05:30", "05:50"], saturday: ["06:10"], weekend: [] } }],
        [],
      ],
      shapes: [
        [
          [49.84, 24.02],
          [49.83, 24.03],
        ],
        [],
      ],
    });
  },
}));

vi.mock("../../actions/routeDynamicInfoAction.js", () => ({
  default: async (req, res) => {
    if (req.params.name === "T31") {
      return res.json([
        { id: "c", direction: 0, location: [49.84, 24.0], bearing: 0, lowfloor: false },
        { id: "a", direction: 0, location: [49.84, 24.02], bearing: 0, lowfloor: true },
        { id: "b", direction: 0, location: [49.84, 24.01], bearing: 0, lowfloor: false },
        { id: "back", direction: 1, location: [49.84, 24.03], bearing: 180, lowfloor: false },
      ]);
    }
    res.json([
      {
        id: "vehicle-1",
        direction: 0,
        location: [49.841, 24.021],
        bearing: 90,
        lowfloor: false,
      },
    ]);
  },
}));

vi.mock("../../actions/getClosestStopsAction.js", () => ({
  default: async (req, res) => {
    res.json([
      {
        code: 101,
        name: "Closest",
        latitude: 49.841,
        longitude: 24.021,
        distance_meters: 42,
        routes: ["Т02", "А01"],
      },
      {
        code: 202,
        name: "Second",
        latitude: 49.842,
        longitude: 24.022,
        distance_meters: 120,
      },
    ]);
  },
}));

vi.mock("../../actions/closestTransportAction.js", () => ({
  default: async (req, res) => {
    res.json([
      {
        id: "vehicle-42",
        route: "T06",
        routeId: "EXT6",
        direction: 0,
        vehicle_type: "tram",
        location: [49.843, 24.025],
        bearing: 45,
        lowfloor: true,
      },
      {
        id: "vehicle-99",
        route: "А01",
        routeId: "EXT1",
        direction: 1,
        vehicle_type: "bus",
        location: [49.844, 24.026],
        bearing: 180,
        lowfloor: false,
      },
    ]);
  },
}));

vi.mock("../../actions/vehicleInfoAction.js", () => ({
  default: async (req, res) => {
    res.json({
      location: [49.841, 24.021],
      routeId: "route-123",
      route: "Т30",
      bearing: 90,
      direction: 0,
      licensePlate: "BC-1234-AB",
      vehicleId: req.params.vehicleId,
      arrivals: [
        // Already passed: the feed keeps stops for a while after the vehicle left.
        { code: 700, name: "Behind", arrival: "Thu, 01 Jan 2026 11:00:00 GMT", departure: null, transfers: [] },
        { code: 707, name: "Opera", arrival: "Fri, 01 Jan 2100 12:05:00 GMT", departure: null, transfers: [] },
        { code: 708, name: "Rynok", arrival: "Fri, 01 Jan 2100 12:08:00 GMT", departure: null, transfers: [] },
      ],
    });
  },
}));

vi.mock("../../services/transitLookupService.js", () => ({
  PASSED_GRACE_MS: 30_000,
  searchStops: vi.fn((query) =>
    query.toLowerCase().startsWith("oper")
      ? [
          { code: 707, name: "Опера", eng_name: "Opera", lat: 49.8437, lng: 24.0263, routes: ["Т01", "А03"] },
          { code: 708, name: "Опера", eng_name: "Opera", lat: 49.8439, lng: 24.0266, routes: ["Т02"] },
        ]
      : [],
  ),
  POINT_WALK_RADIUS_METERS: 600,
  findRoutesBetween: vi.fn((from, to) => {
    if (from === 9999 || to === 9999) return { from: null, to: null, options: [], missing: 9999 };
    // A point in the sea, nowhere near a stop.
    if (typeof from === "object" && from.lat === 10) return { from: null, to: null, options: [], transfer_options: [], missing: "from" };
    if (typeof from === "object") from = 707;
    if (to === 708) {
      return {
        from: { code: from, name: "Опера", codes: [from, 708] },
        to: { code: 708, name: "Опера", codes: [from, 708] },
        options: [],
        transfer_options: [],
        walk_meters: 45,
      };
    }
    const stop = (code, name, lat = 49.84, lng = 24.02) => ({ code, name, eng_name: null, lat, lng, routes: [] });
    if (to === 5555) {
      const leg = (route, board, alight, destination, stops_count) => ({
        route, route_id: `EXT-${route}`, vehicle_type: "bus", direction: 0, destination, board_stop: board, alight_stop: alight, stops_count,
      });
      return {
        from: { code: from, name: "Опера", codes: [from] },
        to: { code: to, name: "Сихів", codes: [to] },
        options: [],
        transfer_options: [
          {
            legs: [
              // The interchange lies east of both ends, off the line between them.
              leg("А03", stop(707, "Опера", 49.87, 23.95), stop(11, "Підвальна", 49.84, 24.035), "Личаків", 1),
              leg("А05", stop(20, "Друкарська", 49.8402, 24.0352), stop(to, "Сихів", 49.807, 23.999), "Сихів", 2),
            ],
            transfer_walk_meters: 30,
            stops_count: 3,
            walk_to_board_meters: 0,
            walk_from_alight_meters: 0,
          },
        ],
      };
    }
    return {
      from: { code: from, name: "Опера", codes: [from, 708] },
      to: { code: to, name: "Вокзал", codes: [to] },
      options: [
        { route: "Т01", route_id: "EXT1", vehicle_type: "tram", direction: 0, destination: "Вокзал", board_stop: stop(708, "Опера"), alight_stop: stop(to, "Вокзал"), stops_count: 4, walk_to_board_meters: 50, walk_from_alight_meters: 0 },
      ],
    };
  }),
  listRouteNames: vi.fn(() => ["А01", "А03", "Н2", "Т01", "Т30"]),
  resolveRoute: vi.fn((name) =>
    name === "T30" || name === "1030"
      ? { external_id: "EXT30", name: "Т30", destinations: ["Рясне", "Сихів"], stops: [[707, 708], [708, 707]] }
      : name === "T31"
        ? { external_id: "EXT31", name: "Т31", destinations: ["Схід", "Захід"], stops: [[700, 707, 708, 709], [709, 700]] }
        : null,
  ),
  destinationsFor: vi.fn((pairs) =>
    Object.fromEntries(pairs.map(({ routeId, direction }) => [`${routeId}:${direction}`, `End of ${routeId}/${direction}`])),
  ),
  etasForVehicles: vi.fn(async (ids) => {
    const at = (minutes) => Date.parse("2026-01-01T12:00:00.000Z") + minutes * 60_000;
    // T31, front to back: a is past 707, b is one stop behind, c is too far back for the feed to reach 707.
    const fixtures = {
      a: [{ code: 708, name: "Тест-708", time: at(2) }, { code: 709, name: "Тест-709", time: at(5) }],
      b: [{ code: 707, name: "Опера", time: at(1) }, { code: 708, name: "Тест-708", time: at(6) }],
      c: [{ code: 700, name: "Тест-700", time: at(0) }],
    };
    return Object.fromEntries(ids.map((id) => [id, fixtures[id] ?? [{ code: 707, name: "Опера", time: at(5) }]]));
  }),
}));

vi.mock("../../services/tripScheduleService.js", () => ({
  // "HH:MM" reads as noon in Kyiv on a fixed day, so the echoed time is stable.
  parseTripTime: vi.fn((value) => (/^\d{1,2}:\d{2}$/.test(value) ? new Date("2026-01-01T10:00:00.000Z") : null)),
  scheduleTrip: vi.fn((legs) => ({
    leave_at: "12:00",
    arrive_at: "12:20",
    total_minutes: 20,
    legs: legs.map((_, i) => ({ board_at: `12:0${4 + i * 4}`, alight_at: `12:1${2 + i * 4}` })),
  })),
  scheduledHeadway: vi.fn((routeId, direction) => (routeId === "EXT31" && direction === 0 ? 5 : null)),
}));

const MOCK_DISRUPTION = {
  id: "t30-detour",
  kind: "detour",
  reason: "Ремонт вул. Тестової",
  since: "2026-10-01",
  until: null,
  until_text: "до кінця року",
  routes: [{ name: "Т30", id: "T30" }],
  stops: [],
  alternatives: [],
  detour: { via: ["вул. Обхідна"], skipped_stops: [1234] },
  note: null,
  source: "Test",
  url: null,
};

vi.mock("../../services/disruptionService.js", () => ({
  // Matches the way the real filter does: by route (either alphabet) or stop.
  activeDisruptions: vi.fn((filter) => {
    if (!filter) return [MOCK_DISRUPTION];
    const routes = [...(filter.routes ?? [])].map((r) => String(r).replace("Т", "T"));
    const stops = [...(filter.stops ?? [])];
    return routes.includes("T30") || stops.includes(1234) ? [MOCK_DISRUPTION] : [];
  }),
  servedFilter: vi.fn(() => () => true),
}));

import { validateToolName } from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";
import pkg from "../../package.json" with { type: "json" };
import {
  buildMcpServerCard,
  handleMcpPostRequest,
  parseArrivalMinutes,
} from "../../mcp/timetableMcpServer.js";

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.post("/mcp", async (req, res) => {
    await handleMcpPostRequest(req, res);
  });

  app.get("/.well-known/mcp/server-card.json", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res.json(buildMcpServerCard(origin));
  });

  app.get("/robots.txt", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res
      .type("text/plain")
      .send(
        [
          "User-agent: *",
          "Disallow: /private/",
          "",
          "# Non-standard hint for AI agent discovery:",
          `# mcp-server: ${origin}/.well-known/mcp/server-card.json`,
        ].join("\n"),
      );
  });

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const TOOL_NAMES = [
  "search_stops",
  "get_stops_around_location",
  "get_stop_realtime",
  "find_routes_between",
  "get_route_static",
  "get_route_realtime",
  "get_nearby_vehicles",
  "get_vehicle_info",
  "get_disruptions",
];

async function connectClient() {
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

describe("timetable MCP server", () => {
  it("registers SEP-conforming tool names", () => {
    for (const name of TOOL_NAMES) {
      const { isValid, warnings } = validateToolName(name);
      expect(isValid, `invalid tool name ${name}: ${warnings.join(", ")}`).toBe(true);
    }
  });

  it("exposes all tools and base capabilities", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    for (const name of TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames).toHaveLength(TOOL_NAMES.length);
    expect(toolNames).not.toContain("get_stop_geometry");
    expect(toolNames).not.toContain("get_vehicles_by_stop");
    expect(toolNames).not.toContain("get_route_dynamic");

    await client.close();
  });

  it("exposes resources including static reference and URI templates", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const listedResources = await client.listResources();
    const resourceUris = listedResources.resources.map((r) => r.uri);
    expect(resourceUris).toEqual(
      expect.arrayContaining([
        "timetable://about",
        "timetable://reference/tools",
        "timetable://reference/prompts",
      ]),
    );

    const aboutResource = await client.readResource({ uri: "timetable://about" });
    const aboutText = aboutResource.contents[0].text;
    expect(aboutText).toContain("Lviv");
    expect(aboutText).toContain("get_stop_realtime");
    expect(aboutText).toContain("get_stops_around_location");
    expect(aboutText).toContain("get_nearby_vehicles");

    const toolsResource = await client.readResource({ uri: "timetable://reference/tools" });
    const toolsText = toolsResource.contents[0].text;
    for (const name of TOOL_NAMES) expect(toolsText).toContain(name);
    expect(toolsText).not.toContain("get_stop_geometry");
    expect(aboutText).not.toContain("get_stop_geometry");
    expect(toolsText).toContain("get_nearby_vehicles");
    expect(toolsText).toContain("get_vehicle_info");

    // Resource templates
    const stopResource = await client.readResource({ uri: "timetable://stop/1234" });
    expect(stopResource.contents[0].mimeType).toBe("application/json");
    const stopData = JSON.parse(stopResource.contents[0].text);
    expect(stopData.code).toBe(1234);
    expect(stopData.name).toBe("Mock Stop");
    expect(stopData.routes).toContain("1A");

    const routeResource = await client.readResource({ uri: "timetable://route/T30" });
    expect(routeResource.contents[0].mimeType).toBe("application/json");
    const routeData = JSON.parse(routeResource.contents[0].text);
    expect(routeData.name).toBe("T30");

    await client.close();
  });

  it("exposes prompts", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((p) => p.name);
    expect(promptNames).toContain("transit-map-view");
    expect(promptNames).toContain("transit-arrival-list");
    expect(promptNames).toContain("transit-hybrid-view");

    const hybridPrompt = await client.getPrompt({
      name: "transit-hybrid-view",
      arguments: { stop_id: "707" },
    });
    expect(hybridPrompt.messages).toHaveLength(1);
    const promptText = hybridPrompt.messages[0].content.text;
    expect(promptText).toContain("get_stop_realtime");
    expect(promptText).toContain("first block `map`, second block `arrival_list`");

    // Stop prompts answer the user, not a JSON-only renderer.
    for (const name of ["transit-map-view", "transit-arrival-list", "transit-hybrid-view"]) {
      const prompt = await client.getPrompt({ name, arguments: { stop_id: "707" } });
      const text = prompt.messages[0].content.text;
      expect(text, name).not.toContain("strict JSON");
      expect(text, name).toContain("language the user wrote in");
    }

    await client.close();
  });

  it("get_stop_realtime returns structured content and NL text summary", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 1234 } });

    // Text is a NL summary, not raw JSON
    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Mock Stop");
    expect(text).toContain("1 arrival");
    expect(() => JSON.parse(text)).toThrow(); // not JSON

    // Structured content carries the full payload
    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0]).toEqual({
      type: "map",
      data: { center: [49.84, 24.02], zoom: 14, layers: { stops: "data.stop", vehicles: "data.arrivals" } },
    });
    expect(sc.ui_blocks[1]).toEqual({ type: "arrival_list", data: { source: "data.arrivals" } });
    expect(sc.data.stop.id).toBe("1234");
    expect(sc.data.arrivals[0].arrival_minutes).toBe(5);

    await client.close();
  });

  it("get_stop_realtime says an arrival has no ETA instead of calling it soon", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 303 } });
    expect(result.structuredContent.data.arrivals[0].arrival_minutes).toBeNull();
    expect(result.content[0].text).toBe("Stop «No ETA Stop»: 1 arrival: Т01 → «Сихів» no ETA.");
    await client.close();
  });

  it("get_route_static leaves polylines out unless asked", async () => {
    const client = await connectClient();

    const result = await client.callTool({ name: "get_route_static", arguments: { route_name: "T30" } });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Route T30");
    expect(text).toContain("outbound");
    // Content-only clients need the timetable too, not just the stop list.
    expect(text).toContain("Departures from «First» (101): workday 05:30 05:50; Saturday 06:10.");

    const sc = result.structuredContent;
    expect(sc.data.route.name).toBe("T30");
    expect(sc.data.stops[0][0]).toMatchObject({ id: "101", name: "First", departures: ["05:30"] });
    expect(sc.data.shapes).toBeUndefined();
    expect(sc.ui_blocks[0].data.layers).toEqual({ stops: "data.stops" });

    const withShapes = await client.callTool({
      name: "get_route_static",
      arguments: { route_name: "T30", include_shapes: true },
    });
    expect(withShapes.structuredContent.data.shapes).toHaveLength(1);
    expect(withShapes.structuredContent.ui_blocks[0].data.layers).toEqual({
      stops: "data.stops",
      polylines: "data.shapes",
    });

    await client.close();
  });

  it("route tools answer an unknown route with a usable hint", async () => {
    const client = await connectClient();

    const result = await client.callTool({ name: "get_route_static", arguments: { route_name: "NOPE" } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Route «NOPE» not found");
    expect(result.content[0].text).toContain("\"Т30\"");

    await client.close();
  });

  it("get_route_realtime returns NL summary and typed direction/lowfloor fields", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: "get_route_realtime", arguments: { route_name: "T30" } });

    const text = result.content.find((c) => c.type === "text")?.text;
    // Canonical name, not the echoed input.
    expect(text).toContain("Route Т30");
    expect(text).toContain("1 active vehicle: vehicle-1 → «Рясне», next stop «Опера» (707)");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.vehicles).toHaveLength(1);
    expect(sc.data.vehicles[0].id).toBe("vehicle-1");
    // direction and lowfloor now have proper types, not unknown
    expect(typeof sc.data.vehicles[0].direction).toBe("number");
    expect(typeof sc.data.vehicles[0].lowfloor).toBe("boolean");
    expect(sc.data.route_name).toBe("Т30");
    expect(sc.data.destinations).toEqual(["Рясне", "Сихів"]);
    expect(sc.data.vehicles[0].destination).toBe("Рясне");
    expect(sc.data.vehicles[0].next_stop).toEqual({ id: "707", name: "Опера", arrival: "2026-01-01T12:05:00.000Z" });
    expect(sc.ui_blocks[0].data.layers).toEqual({ vehicles: "data.vehicles" });

    await client.close();
  });

  it("get_stops_around_location returns NL summary with nearest stop info", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({
      name: "get_stops_around_location",
      arguments: { latitude: 49.84, longitude: 24.02, radius_meters: 800 },
    });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("2 stops");
    expect(text).toContain("Closest");
    expect(text).toContain("42m");

    const sc = result.structuredContent;
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.stops).toHaveLength(2);
    expect(sc.data.stops[0].id).toBe("101");
    expect(sc.data.stops[0].name).toBe("Closest");
    expect(sc.data.stops[0].distance_meters).toBe(42);
    expect(sc.data.stops[0].routes).toEqual(["Т02", "А01"]);
    expect(sc.ui_blocks[0].data.layers).toEqual({ stops: "data.stops" });
    expect(sc.ui_blocks[0].data.center[0]).toBe(49.84);
    expect(sc.ui_blocks[0].data.center[1]).toBe(24.02);

    await client.close();
  });

  it("get_nearby_vehicles returns live vehicles near location with NL summary", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025 },
    });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("2 vehicles within 500m");
    expect(text).toContain("T06");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.vehicles).toHaveLength(2);
    expect(sc.data.vehicles[0].id).toBe("vehicle-42");
    expect(sc.data.vehicles[0].route).toBe("T06");
    expect(typeof sc.data.vehicles[0].lowfloor).toBe("boolean");
    expect(sc.data.vehicles[0].distance_meters).toBe(0);
    expect(sc.data.vehicles[1].distance_meters).toBeGreaterThan(0);
    expect(sc.data.vehicles[0].destination).toBe("End of EXT6/0");
    expect(sc.data.total).toBe(2);

    await client.close();
  });

  it("get_nearby_vehicles filters by route, radius and limit", async () => {
    const client = await connectClient();

    const byRoute = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025, route: "А01" },
    });
    expect(byRoute.structuredContent.data.vehicles.map((v) => v.id)).toEqual(["vehicle-99"]);

    const tight = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025, radius_meters: 100 },
    });
    expect(tight.structuredContent.data.vehicles.map((v) => v.id)).toEqual(["vehicle-42"]);

    const limited = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025, limit: 1 },
    });
    expect(limited.structuredContent.data.vehicles).toHaveLength(1);
    expect(limited.structuredContent.data.total).toBe(2);
    expect(limited.content[0].text).toContain("nearest 1 of 2");

    await client.close();
  });

  it("search_stops returns every matching stop with its routes", async () => {
    const client = await connectClient();

    const result = await client.callTool({ name: "search_stops", arguments: { query: "opera" } });

    expect(result.content[0].text).toContain("2 stops match «opera»");
    const sc = result.structuredContent;
    expect(sc.data.stops[0]).toEqual({
      id: "707",
      name: "Опера",
      eng_name: "Opera",
      lat: 49.8437,
      lng: 24.0263,
      routes: ["Т01", "А03"],
    });
    expect(sc.ui_blocks[0].data.layers).toEqual({ stops: "data.stops" });

    const none = await client.callTool({ name: "search_stops", arguments: { query: "zzz" } });
    expect(none.content[0].text).toContain("No stops match");
    expect(none.structuredContent.ui_blocks).toEqual([]);

    await client.close();
  });

  it("find_routes_between lists direct options and reports unknown stops", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 707, to_stop_id: "101" },
    });

    expect(result.content[0].text).toContain(
      "1 direct route «Опера» → «Вокзал», best first: Т01 towards «Вокзал» from «Опера» (708) to «Вокзал» (101), 4 stops, 50m walk to board; next 3, 15 min (partly scheduled); by timetable leave 12:00, board 12:04, arrive 12:20 (20 min).",
    );
    const sc = result.structuredContent;
    expect(sc.data.from).toEqual({ id: "707", name: "Опера", stop_ids: ["707", "708"] });
    expect(sc.data.options[0]).toMatchObject({
      route: "Т01",
      destination: "Вокзал",
      board_stop: { id: "708", name: "Опера" },
      alight_stop: { id: "101" },
      stops_count: 4,
      walk_to_board_meters: 50,
      walk_from_alight_meters: 0,
    });

    const missing = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 9999, to_stop_id: 101 },
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("Stop 9999 not found");
    expect(sc.data.transfer_options).toEqual([]);
    expect(sc.data.map_stops.map((m) => [m.id, m.role])).toEqual([
      ["708", "board"],
      ["101", "alight"],
    ]);
    expect(sc.ui_blocks[0].data.layers).toEqual({ stops: "data.map_stops" });

    const viaTransfer = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 707, to_stop_id: 5555 },
    });
    expect(viaTransfer.isError).toBeFalsy();
    expect(viaTransfer.content[0].text).toContain(
      "No direct route «Опера» → «Сихів». 1 option with one transfer: А03 from «Опера» (707) to «Підвальна», walk 30m to «Друкарська» (20), then А05 towards «Сихів» (3 stops in total); no live departures; by timetable leave 12:00, board 12:04, arrive 12:20 (20 min).",
    );
    const t = viaTransfer.structuredContent.data.transfer_options[0];
    expect(t.legs.map((l) => [l.route, l.board_stop.id, l.alight_stop.id])).toEqual([
      ["А03", "707", "11"],
      ["А05", "20", "5555"],
    ]);
    expect(t.transfer_walk_meters).toBe(30);
    expect(viaTransfer.structuredContent.data.map_stops.map((m) => [m.id, m.role])).toEqual([
      ["707", "board"],
      ["11", "transfer_alight"],
      ["20", "transfer_board"],
      ["5555", "alight"],
    ]);
    expect(viaTransfer.structuredContent.ui_blocks).toEqual([
      // Centre of the box around all four stops; the ends' midpoint would be 23.9745.
      { type: "map", data: { center: [49.8385, 23.9926], zoom: 12, layers: { stops: "data.map_stops" } } },
    ]);

    await client.close();
  });

  it("find_routes_between tells the user to walk when the stops are a short walk apart", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "find_routes_between", arguments: { from_stop_id: 707, to_stop_id: 708 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.data).toMatchObject({ options: [], transfer_options: [], walk_meters: 45 });
    expect(result.content[0].text).toBe("«Опера» (708) is 45m from «Опера» (707): walk, no ride needed.");
    await client.close();
  });

  it("find_routes_between plans around announced disruptions", async () => {
    const { findRoutesBetween } = await import("../../services/transitLookupService.js");
    const { servedFilter } = await import("../../services/disruptionService.js");
    const client = await connectClient();
    await client.callTool({ name: "find_routes_between", arguments: { from_stop_id: 707, to_stop_id: 4242 } });
    expect(servedFilter).toHaveBeenCalled();
    expect(findRoutesBetween).toHaveBeenLastCalledWith(707, 4242, expect.any(Function));
    await client.close();
  });

  it("find_routes_between carries live next departures of the first leg, that route and way only", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "find_routes_between", arguments: { from_stop_id: 707, to_stop_id: 101 } });
    const [option] = result.structuredContent.data.options;
    // Т01 the other way and Т02 at the same stop are left out; the timetable entry stays, flagged.
    expect(option.next_departures).toEqual([
      { arrival_minutes: 3, scheduled: false, vehicle_id: "t1-a", lowfloor: true },
      { arrival_minutes: 15, scheduled: true, vehicle_id: null, lowfloor: null },
    ]);
    expect(option.schedule).toEqual({ leave_at: "12:00", arrive_at: "12:20", total_minutes: 20, legs: [{ board_at: "12:04", alight_at: "12:12" }] });
    expect(result.structuredContent.data.timing.mode).toBe("depart_at");
    await client.close();
  });

  it("find_routes_between plans for a given time, without live departures", async () => {
    const { scheduleTrip } = await import("../../services/tripScheduleService.js");
    const client = await connectClient();

    const later = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 707, to_stop_id: 102, arrive_by: "12:30" },
    });
    expect(later.structuredContent.data.timing).toEqual({ mode: "arrive_by", at: "12:00" });
    expect(later.structuredContent.data.options[0].next_departures).toBeUndefined();
    expect(scheduleTrip).toHaveBeenLastCalledWith(
      [{ route_id: "EXT1", board_code: 708, alight_code: 102, stops_count: 4 }],
      { to_board_meters: 50, transfer_meters: [], from_alight_meters: 0 },
      { arrive_by: new Date("2026-01-01T10:00:00.000Z") },
    );
    expect(later.content[0].text).toContain("Planned for arriving by 12:00, Lviv time.");

    const both = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 707, to_stop_id: 102, depart_at: "08:00", arrive_by: "09:00" },
    });
    expect(both.isError).toBe(true);
    const garbled = await client.callTool({
      name: "find_routes_between",
      arguments: { from_stop_id: 707, to_stop_id: 102, depart_at: "tomorrow-ish" },
    });
    expect(garbled.isError).toBe(true);
    expect(garbled.content[0].text).toContain("Unreadable time «tomorrow-ish»");
    await client.close();
  });

  it("find_routes_between takes coordinates for either end", async () => {
    const { findRoutesBetween } = await import("../../services/transitLookupService.js");
    const client = await connectClient();

    const result = await client.callTool({
      name: "find_routes_between",
      arguments: { from_lat: 49.8436, from_lng: 24.0261, to_stop_id: 103 },
    });
    expect(result.isError).toBeFalsy();
    expect(findRoutesBetween).toHaveBeenLastCalledWith({ lat: 49.8436, lng: 24.0261 }, 103, expect.any(Function));
    expect(result.structuredContent.data.from).toMatchObject({ id: "707", point: { lat: 49.8436, lng: 24.0261 } });
    expect(result.content[0].text).toContain("your point (nearest stop «Опера») → «Вокзал»");

    const nowhere = await client.callTool({
      name: "find_routes_between",
      arguments: { from_lat: 10, from_lng: 10, to_stop_id: 103 },
    });
    expect(nowhere.isError).toBe(true);
    expect(nowhere.content[0].text).toContain("No stop within 600 m of the start point");

    for (const [args, message] of [
      [{ to_stop_id: 103 }, "Missing the trip's start"],
      [{ from_lat: 49.84, to_stop_id: 103 }, "`from_lat` and `from_lng` go together"],
      [{ from_stop_id: 707, from_lat: 49.84, from_lng: 24.02, to_stop_id: 103 }, "not both"],
    ]) {
      const bad = await client.callTool({ name: "find_routes_between", arguments: args });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toContain(message);
    }
    await client.close();
  });

  it("get_stop_realtime marks timetable entries and filters to low-floor vehicles", async () => {
    const client = await connectClient();

    const all = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 505 } });
    expect(all.structuredContent.data.arrivals.map((a) => [a.vehicle_id, a.lowfloor, a.scheduled])).toEqual([
      ["old-1", false, false],
      ["new-1", true, false],
      [null, null, true],
    ]);
    expect(all.content[0].text).toContain("Т01 → «Вокзал» in 6 min (low-floor)");
    expect(all.content[0].text).toContain("Т01 → «Вокзал» in 20 min (scheduled, not tracked)");

    const step = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 505, lowfloor_only: true } });
    expect(step.structuredContent.data.lowfloor_only).toBe(true);
    expect(step.structuredContent.data.arrivals.map((a) => a.vehicle_id)).toEqual(["new-1"]);
    expect(step.content[0].text).toContain("1 low-floor arrival");
    await client.close();
  });

  it("get_nearby_vehicles filters to low-floor vehicles", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025, lowfloor_only: true },
    });
    expect(result.structuredContent.data.vehicles.map((v) => v.id)).toEqual(["vehicle-42"]);
    expect(result.structuredContent.data.total).toBe(1);
    expect(result.content[0].text).toContain("1 low-floor vehicle within 500m");
    await client.close();
  });

  it("get_route_realtime sums up live gaps and the timetable headway per direction", async () => {
    const client = await connectClient();

    const result = await client.callTool({ name: "get_route_realtime", arguments: { route_name: "T31" } });
    expect(result.structuredContent.data.headways).toEqual([
      // a leads; b reaches a's next stop 4 min after it; c is too far back to time.
      { direction: 0, destination: "Схід", vehicles: 3, gaps_minutes: [4, null], scheduled_headway_minutes: 5 },
      { direction: 1, destination: "Захід", vehicles: 1, gaps_minutes: [], scheduled_headway_minutes: null },
    ]);
    expect(result.content[0].text).toContain(
      "Headways: towards «Схід»: 3 vehicles, gaps 4, ? min, timetable every 5 min; towards «Захід»: 1 vehicle.",
    );

    const oneWay = await client.callTool({ name: "get_route_realtime", arguments: { route_name: "T31", direction: 1 } });
    expect(oneWay.structuredContent.data.direction).toBe(1);
    expect(oneWay.structuredContent.data.vehicles.map((v) => v.id)).toEqual(["back"]);
    expect(oneWay.structuredContent.data.headways.map((h) => h.direction)).toEqual([1]);
    expect(oneWay.content[0].text).toContain("Route Т31 towards «Захід»: 1 active vehicle");
    await client.close();
  });

  it("get_vehicle_info returns vehicle details with NL summary", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({
      name: "get_vehicle_info",
      arguments: { vehicle_id: "vehicle-42" },
    });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("BC-1234-AB");
    expect(text).toContain("2 upcoming");
    // Short name, not the opaque GTFS routeId.
    expect(text).toContain("route Т30");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.route).toBe("Т30");
    expect(sc.data.vehicle_id).toBe("vehicle-42");
    expect(sc.data.destination).toBe("End of route-123/0");
    expect(sc.ui_blocks[0].data.layers).toEqual({ vehicles: "data" });
    expect(sc.data.license_plate).toBe("BC-1234-AB");
    expect(sc.data.upcoming_stops).toHaveLength(2);
    // Named stops and ISO timestamps, not bare codes and RFC 1123.
    expect(sc.data.upcoming_stops[0]).toEqual({
      id: "707",
      name: "Opera",
      arrival: "2100-01-01T12:05:00.000Z",
      departure: null,
    });
    expect(text).toContain("2 upcoming stops: «Opera» (707) in ");
    expect(text).toContain("«Rynok» (708)");

    await client.close();
  });

  it("server card reflects the package version", async () => {
    const serverCardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
    const serverCard = await serverCardResponse.json();
    expect(serverCard.remotes[0].type).toBe("streamable-http");
    expect(serverCard.remotes[0].url).toBe(`${baseUrl}/mcp`);
    expect(serverCard.authentication.type).toBe("none");
    expect(serverCard.title).toBe("Lviv Timetable MCP");
    expect(serverCard.version).toBe(pkg.version);
    expect(serverCard.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.description).toContain("Lviv");
    expect(serverCard.serverInfo?.name).toBe("com.lad.lviv/timetable-api");
    expect(serverCard.serverInfo?.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.serverInfo?.version).toBe(pkg.version);
    expect(serverCard.serverInfo?.description).toContain("Lviv");
    expect(serverCard.iconUrl).toBe(`${baseUrl}/mcp-icon.svg`);
    expect(serverCard.homepage).toBe("https://lad.lviv.ua");
    expect(serverCard.icons?.[0]).toEqual({ src: `${baseUrl}/mcp-icon.svg`, mimeType: "image/svg+xml" });
    expect(serverCard.configSchema?.type).toBe("object");
    expect(serverCard.configSchema?.properties?.default_language).toBeDefined();
    expect(serverCard.configSchema?.exampleConfig).toEqual({ default_language: "any" });
    expect(serverCard.icon).toBe(serverCard.iconUrl);
  });

  it("accepts requests that send params as an explicit null", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: null,
      }),
    });

    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(payload).toContain("get_stop_realtime");
  });

  it.each([
    ["no Accept header", undefined],
    ["application/json only", "application/json"],
    ["a wildcard", "*/*"],
  ])("answers plain JSON to a client sending %s", async (_label, accept) => {
    const headers = { "Content-Type": "application/json" };
    if (accept) headers.Accept = accept;
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const payload = await response.json();
    expect(payload.result.tools.map((t) => t.name)).toContain("get_stop_realtime");
  });

  it("keeps streaming for a client that accepts only text/event-stream", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("serves .well-known robots hint", async () => {
    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    expect(robotsText).toContain("User-agent: *");
    expect(robotsText).toContain(
      `# mcp-server: ${baseUrl}/.well-known/mcp/server-card.json`,
    );
  });
});

describe("MCP additions", () => {
  it("get_stop_realtime answers an unknown stop with a lookup hint", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 404404 } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Stop 404404 not found");
    expect(result.content[0].text).toContain("search_stops");
    await client.close();
  });

  it("get_nearby_vehicles reports an unknown route instead of an empty list", async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: "get_nearby_vehicles",
      arguments: { latitude: 49.843, longitude: 24.025, route: "X999" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Route «X999» not found");
    await client.close();
  });

  it("search_stops echoes the query as typed even when another casing is cached", async () => {
    const client = await connectClient();
    await client.callTool({ name: "search_stops", arguments: { query: "Opera" } });
    const result = await client.callTool({ name: "search_stops", arguments: { query: "OPERA" } });
    expect(result.structuredContent.data.query).toBe("OPERA");
    await client.close();
  });

  it("route resource template completes route names from Latin or Cyrillic input", async () => {
    const client = await connectClient();
    const complete = (value) =>
      client.complete({
        ref: { type: "ref/resource", uri: "timetable://route/{name}" },
        argument: { name: "name", value },
      });
    expect((await complete("t3")).completion.values).toEqual(["Т30"]);
    expect((await complete("a1")).completion.values).toEqual(["А01"]);
    expect((await complete("А")).completion.values).toEqual(["А01", "А03"]);
    await client.close();
  });

  it("resource templates fail with resource-not-found for unknown ids", async () => {
    const client = await connectClient();
    await expect(client.readResource({ uri: "timetable://stop/abc" })).rejects.toMatchObject({ code: -32002 });
    await expect(client.readResource({ uri: "timetable://route/NOPE" })).rejects.toMatchObject({ code: -32002 });
    await client.close();
  });

  it("exposes plan-trip and route-status workflow prompts", async () => {
    const client = await connectClient();
    const trip = await client.getPrompt({ name: "plan-trip", arguments: { from: "Опера", to: "Вокзал" } });
    const tripText = trip.messages[0].content.text;
    expect(tripText).toContain("«Опера»");
    expect(tripText).toContain("find_routes_between");

    const status = await client.getPrompt({ name: "route-status", arguments: { route_name: "Т30" } });
    expect(status.messages[0].content.text).toContain("route_name=Т30");

    const completion = await client.complete({
      ref: { type: "ref/prompt", name: "route-status" },
      argument: { name: "route_name", value: "н" },
    });
    expect(completion.completion.values).toEqual(["Н2"]);
    await client.close();
  });
});

describe("disruptions in MCP results", () => {
  it("get_disruptions lists what is in force, filtered by route or stop", async () => {
    const client = await connectClient();

    const all = await client.callTool({ name: "get_disruptions", arguments: {} });
    expect(all.structuredContent.data.disruptions).toHaveLength(1);
    expect(all.structuredContent.data.route).toBeNull();
    const text = all.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Т30 on a detour via вул. Обхідна");
    expect(text).toContain("до кінця року");

    const other = await client.callTool({ name: "get_disruptions", arguments: { route: "А01" } });
    expect(other.structuredContent.data.disruptions).toEqual([]);
    expect(other.content[0].text).toContain("No announced disruptions for route А01");

    // A numeric external ID is resolved before filtering, not read as bus «А1030».
    const byId = await client.callTool({ name: "get_disruptions", arguments: { route: "1030" } });
    expect(byId.structuredContent.data.route).toBe("Т30");
    expect(byId.structuredContent.data.disruptions.map((d) => d.id)).toEqual(["t30-detour"]);

    const atStop = await client.callTool({ name: "get_disruptions", arguments: { stop_id: "1234" } });
    expect(atStop.structuredContent.data.stop_id).toBe("1234");
    expect(atStop.structuredContent.data.disruptions[0].id).toBe("t30-detour");

    await client.close();
  });

  it("get_route_static carries the route's disruption in data and text", async () => {
    const client = await connectClient();

    const hit = await client.callTool({ name: "get_route_static", arguments: { route_name: "T30" } });
    expect(hit.structuredContent.data.disruptions).toEqual([MOCK_DISRUPTION]);
    expect(hit.content[0].text).toContain("Announced disruptions: Т30 on a detour");

    const miss = await client.callTool({ name: "get_route_static", arguments: { route_name: "А01" } });
    expect(miss.structuredContent.data.disruptions).toBeUndefined();
    expect(miss.content[0].text).not.toContain("Announced disruptions");

    await client.close();
  });

  it("get_stop_realtime carries a disruption touching the stop", async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: "get_stop_realtime", arguments: { stop_id: 1234 } });
    expect(result.structuredContent.data.disruptions?.[0]?.id).toBe("t30-detour");
    await client.close();
  });
});

describe("parseArrivalMinutes", () => {
  it("reads the under-a-minute label as 0, not 1", () => {
    expect(parseArrivalMinutes({ time_left: "< 1хв" })).toBe(0);
  });

  it("reads a plain minute label", () => {
    expect(parseArrivalMinutes({ time_left: "7хв" })).toBe(7);
  });
});
