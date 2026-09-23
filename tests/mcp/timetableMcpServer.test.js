import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

vi.mock("../../actions/getSingleStopAction.js", () => ({
  default: async (req, res) => {
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
        [{ code: 101, name: "First", loc: [49.84, 24.02], departures: ["05:30"], schedule: { workday: ["05:30"], weekend: [] } }],
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
  findRoutesBetween: vi.fn((from, to) => {
    if (from === 9999 || to === 9999) return { from: null, to: null, options: [], missing: 9999 };
    const stop = (code, name) => ({ code, name, eng_name: null, lat: 49.84, lng: 24.02, routes: [] });
    return {
      from: { code: from, name: "Опера", codes: [from, 708] },
      to: { code: to, name: "Вокзал", codes: [to] },
      options: [
        { route: "Т01", vehicle_type: "tram", direction: 0, destination: "Вокзал", board_stop: stop(708, "Опера"), alight_stop: stop(to, "Вокзал"), stops_count: 4, walk_to_board_meters: 50, walk_from_alight_meters: 0 },
      ],
    };
  }),
  resolveRoute: vi.fn((name) =>
    name === "T30" ? { external_id: "EXT30", name: "Т30", destinations: ["Рясне", "Сихів"] } : null,
  ),
  destinationsFor: vi.fn((pairs) =>
    Object.fromEntries(pairs.map(({ routeId, direction }) => [`${routeId}:${direction}`, `End of ${routeId}/${direction}`])),
  ),
  nextStopsForVehicles: vi.fn(async (ids) =>
    Object.fromEntries(ids.map((id) => [id, { code: 707, name: "Опера", arrival: "2026-01-01T12:05:00.000Z" }])),
  ),
}));

import { validateToolName } from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";
import pkg from "../../package.json" with { type: "json" };
import {
  buildMcpServerCard,
  handleMcpPostRequest,
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

  it("get_route_static leaves polylines out unless asked", async () => {
    const client = await connectClient();

    const result = await client.callTool({ name: "get_route_static", arguments: { route_name: "T30" } });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Route T30");
    expect(text).toContain("outbound");

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
    expect(text).toContain("1 active vehicle (1 → «Рясне»)");

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
      "1 direct route «Опера» → «Вокзал». Best: Т01 towards «Вокзал», 4 stops, board at «Опера» (50m walk).",
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
    expect(text).toContain("Next stop: «Opera»");

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

  it("serves .well-known robots hint", async () => {
    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    expect(robotsText).toContain("User-agent: *");
    expect(robotsText).toContain(
      `# mcp-server: ${baseUrl}/.well-known/mcp/server-card.json`,
    );
  });
});
