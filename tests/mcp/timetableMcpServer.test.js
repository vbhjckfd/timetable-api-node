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
      timetable: includeTimetable ? [{ route: "1A", time: "12:00" }] : [],
    });
  },
}));

vi.mock("../../actions/getStopTimetableAction.js", () => ({
  default: async (req, res) => {
    res.json([{ stopCode: req.stopCode, route: "3", time: "12:05" }]);
  },
}));

vi.mock("../../actions/getClosestStopsAction.js", () => ({
  default: async (req, res) => {
    res.json([
      {
        code: 101,
        name: "Closest",
        latitude: Number(req.query.latitude),
        longitude: Number(req.query.longitude),
      },
    ]);
  },
}));

vi.mock("../../actions/routeStaticInfoAction.js", () => ({
  default: async (req, res) => {
    res.json({
      route_short_name: req.params.name,
      stops: [[], []],
      shapes: [[], []],
    });
  },
}));

vi.mock("../../actions/routeDynamicInfoAction.js", () => ({
  default: async (req, res) => {
    res.json([
      {
        id: "vehicle-1",
        direction: 0,
        location: [49.84, 24.02],
      },
    ]);
  },
}));

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

describe("timetable MCP server", () => {
  it("exposes MCP tools and executes get_stop_by_code", async () => {
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain("get_stop_by_code");
    expect(toolNames).toContain("get_route_dynamic");
    expect(toolNames).not.toContain("get_vehicle_by_id");

    const result = await client.callTool({
      name: "get_stop_by_code",
      arguments: {
        stop_code: 1234,
        include_timetable: true,
      },
    });

    const textContent = result.content.find((item) => item.type === "text")?.text;
    expect(textContent).toContain('"code": 1234');
    expect(textContent).toContain('"route": "1A"');

    await client.close();
  });

  it("serves .well-known server card and robots hint", async () => {
    const serverCardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
    const serverCard = await serverCardResponse.json();
    expect(serverCard.remotes[0].type).toBe("streamable-http");
    expect(serverCard.remotes[0].url).toBe(`${baseUrl}/mcp`);
    expect(serverCard.authentication.type).toBe("none");

    const robotsResponse = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await robotsResponse.text();
    expect(robotsText).toContain("User-agent: *");
    expect(robotsText).toContain(
      `# mcp-server: ${baseUrl}/.well-known/mcp/server-card.json`,
    );
  });
});
