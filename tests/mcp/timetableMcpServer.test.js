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
];

describe("timetable MCP server", () => {
  it("registers SEP-conforming tool names", () => {
    for (const name of TOOL_NAMES) {
      const { isValid, warnings } = validateToolName(name);
      expect(isValid, `invalid tool name ${name}: ${warnings.join(", ")}`).toBe(true);
    }
  });

  it("exposes MCP tools and executes transit map/list tools", async () => {
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

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain("get_stop_realtime");
    expect(toolNames).toContain("get_route_static");
    expect(toolNames).toContain("get_route_realtime");
    expect(toolNames).toContain("get_stop_geometry");
    expect(toolNames).toContain("get_stops_around_location");
    expect(toolNames).not.toContain("get_vehicles_by_stop");
    expect(toolNames).not.toContain("get_route_dynamic");

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((prompt) => prompt.name);
    expect(promptNames).toContain("transit-map-view");
    expect(promptNames).toContain("transit-arrival-list");
    expect(promptNames).toContain("transit-hybrid-view");

    const hybridPrompt = await client.getPrompt({
      name: "transit-hybrid-view",
      arguments: {
        stop_id: "707",
      },
    });
    expect(hybridPrompt.messages).toHaveLength(1);
    const promptText = hybridPrompt.messages[0].content.text;
    expect(promptText).toContain("get_stop_realtime");
    expect(promptText).toContain("first block `map`, second block `arrival_list`");

    const stopRealtime = await client.callTool({
      name: "get_stop_realtime",
      arguments: {
        stop_id: 1234,
      },
    });
    const stopRealtimeText = stopRealtime.content.find((item) => item.type === "text")?.text;
    const stopRealtimeJson = JSON.parse(stopRealtimeText);
    expect(stopRealtimeJson.view).toBe("transit_realtime");
    expect(stopRealtimeJson.ui_blocks[0].type).toBe("map");
    expect(stopRealtimeJson.ui_blocks[1].type).toBe("arrival_list");
    expect(stopRealtimeJson.data.stop.id).toBe("1234");
    expect(stopRealtimeJson.data.arrivals[0].arrival_minutes).toBe(5);

    const routeStatic = await client.callTool({
      name: "get_route_static",
      arguments: { route_name: "T30" },
    });
    const routeStaticJson = JSON.parse(routeStatic.content.find((i) => i.type === "text")?.text);
    expect(routeStaticJson.view).toBe("transit_realtime");
    expect(routeStaticJson.ui_blocks[0].type).toBe("map");
    expect(routeStaticJson.ui_blocks[0].data.polylines).toHaveLength(1);
    expect(routeStaticJson.data.route.name).toBe("T30");

    const routeRealtime = await client.callTool({
      name: "get_route_realtime",
      arguments: { route_name: "T30" },
    });
    const routeRealtimeJson = JSON.parse(routeRealtime.content.find((i) => i.type === "text")?.text);
    expect(routeRealtimeJson.view).toBe("transit_realtime");
    expect(routeRealtimeJson.ui_blocks[0].type).toBe("map");
    expect(routeRealtimeJson.data.vehicles).toHaveLength(1);
    expect(routeRealtimeJson.data.vehicles[0].id).toBe("vehicle-1");

    const stopGeometry = await client.callTool({
      name: "get_stop_geometry",
      arguments: {
        stop_id: "1234",
      },
    });
    const stopGeometryText = stopGeometry.content.find((item) => item.type === "text")?.text;
    const stopGeometryJson = JSON.parse(stopGeometryText);
    expect(stopGeometryJson.ui_blocks[0].type).toBe("map");
    expect(stopGeometryJson.data.routes[0].route).toBe("1A");
    expect(stopGeometryJson.data.routes[0].polyline).toHaveLength(2);

    const stopsAround = await client.callTool({
      name: "get_stops_around_location",
      arguments: {
        latitude: 49.84,
        longitude: 24.02,
        radius_meters: 800,
      },
    });
    const stopsAroundText = stopsAround.content.find((item) => item.type === "text")?.text;
    const stopsAroundJson = JSON.parse(stopsAroundText);
    expect(stopsAroundJson.ui_blocks[0].type).toBe("map");
    expect(stopsAroundJson.data.stops).toHaveLength(2);
    expect(stopsAroundJson.data.stops[0].id).toBe("101");
    expect(stopsAroundJson.data.stops[0].name).toBe("Closest");
    expect(stopsAroundJson.data.stops[0].distance_meters).toBe(42);
    expect(stopsAroundJson.ui_blocks[0].data.stops).toHaveLength(2);
    expect(stopsAroundJson.ui_blocks[0].data.center[0]).toBe(49.84);
    expect(stopsAroundJson.ui_blocks[0].data.center[1]).toBe(24.02);

    await client.close();
  });

  it("serves .well-known server card and robots hint", async () => {
    const serverCardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
    const serverCard = await serverCardResponse.json();
    expect(serverCard.remotes[0].type).toBe("streamable-http");
    expect(serverCard.remotes[0].url).toBe(`${baseUrl}/mcp`);
    expect(serverCard.authentication.type).toBe("none");
    expect(serverCard.title).toBe("Lviv Timetable MCP");
    expect(serverCard.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.description).toContain("Lviv");
    expect(serverCard.serverInfo?.name).toBe("com.lad.lviv/timetable-api");
    expect(serverCard.serverInfo?.websiteUrl).toBe("https://lad.lviv.ua");
    expect(serverCard.serverInfo?.description).toContain("Lviv");
    expect(serverCard.iconUrl).toBe(`${baseUrl}/mcp-icon.svg`);
    expect(serverCard.homepage).toBe("https://lad.lviv.ua");
    expect(serverCard.icons?.[0]).toEqual({ src: `${baseUrl}/mcp-icon.svg`, mimeType: "image/svg+xml" });
    expect(serverCard.configSchema?.type).toBe("object");
    expect(serverCard.configSchema?.properties?.default_language).toBeDefined();
    expect(serverCard.configSchema?.exampleConfig).toEqual({ default_language: "any" });
    expect(serverCard.icon).toBe(serverCard.iconUrl);

    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    expect(robotsText).toContain("User-agent: *");
    expect(robotsText).toContain(
      `# mcp-server: ${baseUrl}/.well-known/mcp/server-card.json`,
    );
  });
});
