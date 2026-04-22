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
  "get_vehicles_by_stop",
  "get_stop_geometry",
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

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain("get_stop_realtime");
    expect(toolNames).toContain("get_vehicles_by_stop");
    expect(toolNames).toContain("get_stop_geometry");
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

    const vehiclesByStop = await client.callTool({
      name: "get_vehicles_by_stop",
      arguments: {
        stop_ids: [1234, "707"],
      },
    });
    const vehiclesByStopText = vehiclesByStop.content.find((item) => item.type === "text")?.text;
    const vehiclesByStopJson = JSON.parse(vehiclesByStopText);
    expect(vehiclesByStopJson.ui_blocks[0].type).toBe("map");
    expect(vehiclesByStopJson.data.stops).toHaveLength(2);
    expect(vehiclesByStopJson.data.vehicles[0].id).toBe("vehicle-1");

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
