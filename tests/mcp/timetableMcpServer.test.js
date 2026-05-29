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
    res.json({
      route_short_name: req.params.name,
      route_long_name: "Mock Long Name",
      color: "#FF0000",
      type: "tram",
      stops: [[], []],
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
        vehicle_type: "tram",
        location: [49.843, 24.025],
        bearing: 45,
        lowfloor: true,
      },
      {
        id: "vehicle-99",
        route: "А01",
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
      bearing: 90,
      direction: 0,
      licensePlate: "BC-1234-AB",
      vehicleId: req.params.vehicleId,
      arrivals: [
        { code: 707, arrival: "2026-01-01T12:05:00Z", departure: null, transfers: [] },
        { code: 708, arrival: "2026-01-01T12:08:00Z", departure: null, transfers: [] },
      ],
    });
  },
}));

vi.mock("../../actions/planTripAction.js", () => ({
  default: async (req, res) => {
    const origin = parseInt(req.query.origin, 10);
    const destination = parseInt(req.query.destination, 10);
    if (origin === destination) {
      return res.status(400).json({ error: "Origin and destination must be different stops" });
    }
    res.json({
      origin: { id: String(origin), name: "Origin Stop" },
      destination: { id: String(destination), name: "Destination Stop" },
      options: [
        {
          type: "direct",
          route: "Т01",
          direction: 0,
          board_stop_code: origin,
          board_stop_name: "Origin Stop",
          alight_stop_code: destination,
          alight_stop_name: "Destination Stop",
          stops_count: 5,
        },
      ],
    });
  },
}));

import { validateToolName } from "@modelcontextprotocol/sdk/shared/toolNameValidation.js";
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
  "get_stop_realtime",
  "get_route_static",
  "get_route_realtime",
  "get_stop_geometry",
  "get_stops_around_location",
  "get_nearby_vehicles",
  "get_vehicle_info",
  "plan_trip",
];

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
    expect(aboutText).toContain("plan_trip");

    const toolsResource = await client.readResource({ uri: "timetable://reference/tools" });
    const toolsText = toolsResource.contents[0].text;
    expect(toolsText).toContain("get_nearby_vehicles");
    expect(toolsText).toContain("get_vehicle_info");
    expect(toolsText).toContain("plan_trip");

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
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.ui_blocks[1].type).toBe("arrival_list");
    expect(sc.data.stop.id).toBe("1234");
    expect(sc.data.arrivals[0].arrival_minutes).toBe(5);

    await client.close();
  });

  it("get_route_static returns NL summary and structured map block", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: "get_route_static", arguments: { route_name: "T30" } });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Route T30");
    expect(text).toContain("outbound");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.ui_blocks[0].data.polylines).toHaveLength(1);
    expect(sc.data.route.name).toBe("T30");

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
    expect(text).toContain("Route T30");
    expect(text).toContain("1 active vehicle");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.vehicles).toHaveLength(1);
    expect(sc.data.vehicles[0].id).toBe("vehicle-1");
    // direction and lowfloor now have proper types, not unknown
    expect(typeof sc.data.vehicles[0].direction).toBe("number");
    expect(typeof sc.data.vehicles[0].lowfloor).toBe("boolean");

    await client.close();
  });

  it("get_stop_geometry fetches route shapes in parallel and returns NL summary", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: "get_stop_geometry", arguments: { stop_id: "1234" } });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Mock Stop");
    expect(text).toContain("serving route");

    const sc = result.structuredContent;
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.routes[0].route).toBe("1A");
    expect(sc.data.routes[0].polyline).toHaveLength(2);

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
    expect(sc.ui_blocks[0].data.stops).toHaveLength(2);
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
    expect(text).toContain("2 vehicles");
    expect(text).toContain("T06");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.vehicles).toHaveLength(2);
    expect(sc.data.vehicles[0].id).toBe("vehicle-42");
    expect(sc.data.vehicles[0].route).toBe("T06");
    expect(typeof sc.data.vehicles[0].lowfloor).toBe("boolean");

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

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.ui_blocks[0].type).toBe("map");
    expect(sc.data.license_plate).toBe("BC-1234-AB");
    expect(sc.data.upcoming_stops).toHaveLength(2);
    expect(sc.data.upcoming_stops[0].code).toBe(707);

    await client.close();
  });

  it("plan_trip returns direct trip option with NL summary", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({
      name: "plan_trip",
      arguments: { origin_stop_id: 707, destination_stop_id: 808 },
    });

    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toContain("Direct trip");
    expect(text).toContain("Origin Stop");
    expect(text).toContain("Destination Stop");
    expect(text).toContain("5 stops");

    const sc = result.structuredContent;
    expect(sc.view).toBe("transit_realtime");
    expect(sc.data.options).toHaveLength(1);
    expect(sc.data.options[0].type).toBe("direct");
    expect(sc.data.options[0].route).toBe("Т01");
    expect(sc.data.options[0].stops_count).toBe(5);
    expect(sc.data.origin.id).toBe("707");
    expect(sc.data.destination.id).toBe("808");

    await client.close();
  });

  it("plan_trip returns error result for same origin and destination", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({
      name: "plan_trip",
      arguments: { origin_stop_id: 707, destination_stop_id: 707 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("different");

    await client.close();
  });

  it("server card reflects version 1.1.4", async () => {
    const serverCardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
    const serverCard = await serverCardResponse.json();
    expect(serverCard.remotes[0].type).toBe("streamable-http");
    expect(serverCard.remotes[0].url).toBe(`${baseUrl}/mcp`);
    expect(serverCard.authentication.type).toBe("none");
    expect(serverCard.title).toBe("Lviv Timetable MCP");
    expect(serverCard.version).toBe("1.1.4");
    expect(serverCard.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.description).toContain("Lviv");
    expect(serverCard.serverInfo?.name).toBe("com.lad.lviv/timetable-api");
    expect(serverCard.serverInfo?.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.serverInfo?.version).toBe("1.1.4");
    expect(serverCard.serverInfo?.description).toContain("Lviv");
    expect(serverCard.iconUrl).toBe(`${baseUrl}/mcp-icon.svg`);
    expect(serverCard.homepage).toBe("https://lad.lviv.ua");
    expect(serverCard.icons?.[0]).toEqual({ src: `${baseUrl}/mcp-icon.svg`, mimeType: "image/svg+xml" });
    expect(serverCard.configSchema?.type).toBe("object");
    expect(serverCard.configSchema?.properties?.default_language).toBeDefined();
    expect(serverCard.configSchema?.exampleConfig).toEqual({ default_language: "any" });
    expect(serverCard.icon).toBe(serverCard.iconUrl);
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
