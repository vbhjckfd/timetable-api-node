import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import getClosestStopsAction from "../actions/getClosestStopsAction.js";
import getSingleStopAction from "../actions/getSingleStopAction.js";
import getStopTimetableAction from "../actions/getStopTimetableAction.js";
import routeInfoDynamicAction from "../actions/routeDynamicInfoAction.js";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

function createMockResponse() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: undefined,
    set(name, value) {
      headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      this.body = undefined;
      return this;
    },
  };
}

async function runAction(action, reqOverrides = {}) {
  let nextError;
  const req = {
    params: {},
    query: {},
    ...reqOverrides,
  };
  const res = createMockResponse();
  const next = (error) => {
    if (error) {
      nextError = error;
    }
  };

  await action(req, res, next);

  if (nextError) {
    throw nextError;
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
  };
}

function formatToolResult(toolName, actionResult) {
  const { statusCode, body } = actionResult;

  if (statusCode >= 400) {
    const errorText =
      typeof body === "string" ? body : `${toolName} failed with status ${statusCode}`;
    return {
      isError: true,
      content: [{ type: "text", text: errorText }],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(body ?? null, null, 2),
      },
    ],
  };
}

function registerTools(server) {
  server.registerTool(
    "get_stop_by_code",
    {
      title: "Get Stop By Code",
      description:
        "Returns stop information by numeric stop code. Optionally includes live timetable data.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_code: z.number().int().positive(),
        include_timetable: z.boolean().default(false),
      },
    },
    async ({ stop_code, include_timetable }) => {
      const actionResult = await runAction(getSingleStopAction, {
        stopCode: stop_code,
        query: { skipTimetableData: include_timetable ? "false" : "true" },
      });
      return formatToolResult("get_stop_by_code", actionResult);
    },
  );

  server.registerTool(
    "get_stop_timetable",
    {
      title: "Get Stop Timetable",
      description: "Returns current timetable arrivals for a specific stop code.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_code: z.number().int().positive(),
      },
    },
    async ({ stop_code }) => {
      const actionResult = await runAction(getStopTimetableAction, {
        stopCode: stop_code,
      });
      return formatToolResult("get_stop_timetable", actionResult);
    },
  );

  server.registerTool(
    "get_closest_stops",
    {
      title: "Get Closest Stops",
      description: "Returns stops within 1km of latitude/longitude, sorted by distance.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      },
    },
    async ({ latitude, longitude }) => {
      const actionResult = await runAction(getClosestStopsAction, {
        query: {
          latitude: String(latitude),
          longitude: String(longitude),
        },
      });
      return formatToolResult("get_closest_stops", actionResult);
    },
  );

  server.registerTool(
    "get_route_static",
    {
      title: "Get Route Static",
      description:
        "Returns static route data including stops, shapes, departures, and transfer options.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: z.string().min(1),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeInfoStaticAction, {
        params: { name: route_name },
      });
      return formatToolResult("get_route_static", actionResult);
    },
  );

  server.registerTool(
    "get_route_dynamic",
    {
      title: "Get Route Dynamic",
      description:
        "Returns live vehicle positions and direction details for a route.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: z.string().min(1),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeInfoDynamicAction, {
        params: { name: route_name },
      });
      return formatToolResult("get_route_dynamic", actionResult);
    },
  );
}

export function createTimetableMcpServer() {
  const server = new McpServer(
    {
      name: "com.lad.lviv/timetable-api",
      title: "Lviv Timetable API",
      version: "1.0.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(server);
  return server;
}

export async function handleMcpPostRequest(req, res) {
  const server = createTimetableMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    await transport.close();
    await server.close();
  }
}

export function buildMcpServerCard(baseUrl) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    name: "com.lad.lviv/timetable-api",
    title: "Lviv Timetable API",
    description: "Read-only MCP server for Lviv public transport timetable data.",
    version: "1.0.0",
    remotes: [
      {
        type: "streamable-http",
        url: `${normalizedBaseUrl}/mcp`,
      },
    ],
    authentication: {
      type: "none",
    },
  };
}
