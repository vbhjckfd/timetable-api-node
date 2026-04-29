import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import getSingleStopAction from "../actions/getSingleStopAction.js";
import getClosestStopsAction from "../actions/getClosestStopsAction.js";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Exposed in MCP `initialize` and in `/.well-known/mcp/server-card.json` (Smithery, client UIs). */
const MCP_SERVER_INFO = {
  name: "com.lad.lviv/timetable-api",
  title: "Lviv Timetable MCP",
  version: "1.0.0",
  description:
    "Read-only access to Lviv, Ukraine public transport: stops, routes, static shapes, live vehicle positions, and terminus timetables. Sourced from municipal GTFS and GTFS-RT. No API key, OAuth, or user configuration is required.",
  websiteUrl: "https://lad.lviv.ua",
};

/**
 * Public base URL for MCP icon and (optional) config hints. Override with MCP_PUBLIC_BASE_URL
 * when the API is not hosted at the default host (e.g. local staging).
 */
function publicMcpBaseUrl() {
  return (process.env.MCP_PUBLIC_BASE_URL || "https://api.lad.lviv.ua").replace(/\/+$/, "");
}

function mcpIconAbsoluteUrl() {
  return new URL("mcp-icon.svg", `${publicMcpBaseUrl()}/`).href;
}

const SMITHERY_CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  title: "Client preferences (optional)",
  description:
    "This API requires no API keys. All fields are optional. The upstream server may ignore them; they exist for client UX and Smithery session config.",
  properties: {
    default_language: {
      type: "string",
      title: "Preferred prompt language",
      description:
        "Optional hint: prefer English, Ukrainian, or any tools/prompts (informational; may be ignored by the host).",
      enum: ["en", "uk", "any"],
      default: "any",
    },
  },
  required: [],
  additionalProperties: false,
  // Smithery convention (see microsoft/mcp smithery.yaml): sample empty / default connection.
  exampleConfig: { default_language: "any" },
};

const MCP_SERVER_INSTRUCTIONS = [
  "Lviv, Ukraine public transport realtime assistant with strict UI contracts.",
  "Always return structured JSON using ui_blocks for map and arrival list rendering.",
  "No authentication. Stop IDs are numeric codes shown on stop signage.",
].join(" ");

function zStopId() {
  return z.union([
    z
      .number()
      .int()
      .positive()
      .describe("Numeric municipal stop code (e.g. 707)."),
    z
      .string()
      .regex(/^\d+$/)
      .describe("Municipal stop code as digits-only string (e.g. \"707\")."),
  ]);
}

function normalizeStopCode(stopId) {
  const parsed = Number.parseInt(String(stopId), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid stop_id: ${stopId}`);
  }
  return parsed;
}

function normalizeCoordinate(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(5)) : null;
}

function normalizeBearing(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArrivalMinutes(entry) {
  if (Number.isFinite(entry.arrival_minutes)) {
    return Math.max(0, Math.round(entry.arrival_minutes));
  }
  if (typeof entry.time_left === "string") {
    const minutesMatch = entry.time_left.match(/\d+/);
    if (minutesMatch) {
      return Number.parseInt(minutesMatch[0], 10);
    }
  }
  if (typeof entry.arrival_time === "string") {
    const arrivalMs = Date.parse(entry.arrival_time);
    if (Number.isFinite(arrivalMs)) {
      const diffMinutes = Math.ceil((arrivalMs - Date.now()) / 60000);
      return diffMinutes >= 0 ? diffMinutes : 0;
    }
  }
  return null;
}

function normalizeRealtimeArrival(entry) {
  const [rawLat, rawLng] = Array.isArray(entry.location)
    ? entry.location
    : [entry.lat, entry.lng];
  return {
    route: entry.route ?? null,
    direction: entry.direction ?? entry.end_stop ?? null,
    vehicle_type: entry.vehicle_type ?? null,
    arrival_minutes: parseArrivalMinutes(entry),
    vehicle_id: entry.vehicle_id ?? null,
    lat: normalizeCoordinate(rawLat),
    lng: normalizeCoordinate(rawLng),
    bearing: normalizeBearing(entry.bearing),
  };
}

function sortedArrivals(arrivals) {
  return [...arrivals].sort((a, b) => {
    if (a.arrival_minutes === null && b.arrival_minutes === null) return 0;
    if (a.arrival_minutes === null) return 1;
    if (b.arrival_minutes === null) return -1;
    return a.arrival_minutes - b.arrival_minutes;
  });
}

function toMapVehicle(item, fallbackId, nextStopId = null) {
  const vehicleId = item.vehicle_id ?? item.id ?? fallbackId;
  const etaMinutes = Number.isFinite(item.arrival_minutes) ? item.arrival_minutes : item.eta_minutes;
  return {
    id: vehicleId,
    route: item.route ?? null,
    lat: normalizeCoordinate(item.lat),
    lng: normalizeCoordinate(item.lng),
    bearing: normalizeBearing(item.bearing),
    next_stop_id: nextStopId ?? item.next_stop_id ?? null,
    eta_minutes: Number.isFinite(etaMinutes) ? Math.max(0, Math.round(etaMinutes)) : null,
    eta_status: Number.isFinite(etaMinutes) ? "assigned" : "unassigned",
  };
}

function buildUiPayload(toolName, body) {
  const payload = body ?? {};

  if (toolName === "get_stop_realtime") {
    const arrivals = sortedArrivals(Array.isArray(payload.arrivals) ? payload.arrivals : []);
    const mapVehicles = arrivals.map((item, index) =>
      toMapVehicle(item, `vehicle-${index + 1}`, payload.stop?.id ?? null),
    );
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [payload.stop?.lat ?? null, payload.stop?.lng ?? null],
            zoom: 14,
            stop: payload.stop ?? null,
            vehicles: mapVehicles,
          },
        },
        {
          type: "arrival_list",
          data: {
            stop: payload.stop ?? null,
            arrivals,
          },
        },
      ],
    };
  }

  if (toolName === "get_vehicles_by_stop") {
    const vehicles = Array.isArray(payload.vehicles)
      ? payload.vehicles.map((item, index) => toMapVehicle(item, `vehicle-${index + 1}`))
      : [];
    const centerStop = Array.isArray(payload.stops) && payload.stops.length > 0 ? payload.stops[0] : null;
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [centerStop?.lat ?? null, centerStop?.lng ?? null],
            zoom: 14,
            stops: payload.stops ?? [],
            vehicles,
          },
        },
      ],
    };
  }

  if (toolName === "get_stop_geometry") {
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [payload.stop?.lat ?? null, payload.stop?.lng ?? null],
            zoom: 14,
            stop: payload.stop ?? null,
            routes: payload.routes ?? [],
            vehicles: [],
          },
        },
      ],
    };
  }

  if (toolName === "get_stops_around_location") {
    const stops = Array.isArray(payload.stops) ? payload.stops : [];
    const centerLat = payload.center_lat ?? null;
    const centerLng = payload.center_lng ?? null;
    const radius =
      typeof payload.radius_meters === "number" && Number.isFinite(payload.radius_meters)
        ? payload.radius_meters
        : 1000;
    const zoom = radius > 1500 ? 14 : 15;
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [centerLat, centerLng],
            zoom,
            stops,
            vehicles: [],
          },
        },
      ],
    };
  }

  return {
    view: "transit_realtime",
    data: payload,
    ui_blocks: [],
  };
}

function mcpServerImplementation() {
  return {
    ...MCP_SERVER_INFO,
    icons: [
      {
        src: mcpIconAbsoluteUrl(),
        mimeType: "image/svg+xml",
      },
      {
        src: new URL("favicon.ico", `${MCP_SERVER_INFO.websiteUrl}/`).href,
        mimeType: "image/x-icon",
      },
    ],
  };
}

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
        text: JSON.stringify(buildUiPayload(toolName, body), null, 2),
      },
    ],
  };
}

const MCP_RESOURCES = {
  about: `## Lviv Timetable MCP

Read-only access to **public** timetable and live vehicle data for municipal transit in **Lviv, Ukraine** (lad.lviv.ua ecosystem).

### How to work with this server

- Prefer **tools** for structured JSON from the API.
- Use **prompts** for ready-made Ukrainian/English workflows (route status, nearby stops, slang phrasing).
- Use **resources** (this page and siblings under \`timetable://\`) for human-readable reference without calling tools.

### Data notes

- Times and positions come from upstream feeds; gaps or delays are possible.
- For precise "when does my bus arrive at *this* stop", use \`get_stop_realtime\` for one stop or \`get_vehicles_by_stop\` for stop groups.
- To show **nearby stops on a map** (names + codes around coordinates), use \`get_stops_around_location\`.
`,

  tools: `## Tools reference

| Tool | Purpose |
|------|---------|
| \`get_stop_realtime\` | Realtime arrivals and live vehicles for one stop; includes map + arrival-list UI blocks. |
| \`get_vehicles_by_stop\` | Map-oriented vehicle feed across one or multiple stop IDs. |
| \`get_stop_geometry\` | Static map context for a stop (stop marker + route polylines). |
| \`get_stops_around_location\` | Stops near lat/lon (code, name, coordinates, distance); **map** UI block with multiple markers (ChatGPT-friendly). |

All tools are **read-only** and safe to retry.
`,

  prompts: `## Prompts reference

Prompts are reusable instruction templates. Pass the listed **arguments** when invoking a prompt.

### English

| Prompt | Arguments | Use case |
|--------|-----------|----------|
| \`transit-map-view\` | \`stop_id\` | Map-first rendering for live vehicles near a stop. |
| \`transit-arrival-list\` | \`stop_id\` | Arrival list sorted by ETA, grouped by route when needed. |
| \`transit-hybrid-view\` | \`stop_id\` | Map (top) + arrival list (bottom) with ETA consistency checks. |
`,
};

function registerResources(server) {
  server.registerResource(
    "about",
    "timetable://about",
    {
      title: "About Lviv Timetable MCP",
      description: "Scope, usage, and data caveats for this server.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.about }],
    }),
  );

  server.registerResource(
    "tools-reference",
    "timetable://reference/tools",
    {
      title: "Tools reference",
      description: "What each MCP tool returns and when to use it.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.tools }],
    }),
  );

  server.registerResource(
    "prompts-reference",
    "timetable://reference/prompts",
    {
      title: "Prompts reference",
      description: "Catalog of prompt templates (EN/UA) and their arguments.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.prompts }],
    }),
  );
}

function registerTools(server) {
  server.registerTool(
    "get_stop_realtime",
    {
      title: "Get Stop Realtime",
      description:
        "Returns live arrivals and vehicle positions for a single stop, producing both a map UI block and a structured arrival list. " +
        "Use this as the **default tool** when the user asks about arrivals, departures, or vehicles at a specific stop. " +
        "Prefer `get_vehicles_by_stop` when you need to aggregate data across **multiple stops** and only need a map (no arrival list). " +
        "Prefer `get_stop_geometry` when only static route polylines are needed and live data is irrelevant. " +
        "Requires a numeric stop ID (shown on stop signage); use `get_stops_around_location` first if you only have an address or coordinates.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_id: zStopId(),
      },
    },
    async ({ stop_id }) => {
      const stopCode = normalizeStopCode(stop_id);
      const actionResult = await runAction(getSingleStopAction, {
        stopCode,
        query: { skipTimetableData: "false" },
      });
      if (actionResult.statusCode >= 400) {
        return formatToolResult("get_stop_realtime", actionResult);
      }

      const body = actionResult.body ?? {};
      const payload = {
        stop: {
          id: String(body.code),
          name: body.name ?? null,
          lat: normalizeCoordinate(body.latitude),
          lng: normalizeCoordinate(body.longitude),
        },
        arrivals: Array.isArray(body.timetable)
          ? body.timetable.map((item) => normalizeRealtimeArrival(item))
          : [],
        updated_at: new Date().toISOString(),
      };

      return formatToolResult("get_stop_realtime", { statusCode: 200, body: payload });
    },
  );

  server.registerTool(
    "get_vehicles_by_stop",
    {
      title: "Get Vehicles By Stop",
      description:
        "Returns live vehicle positions for one or more stop IDs, optimised for map rendering. " +
        "Use this tool when you need to show vehicles across **multiple stops** on a single map (e.g. a stop group or interchange), or when vehicle positions and ETAs are the primary output and an arrival-list is not required. " +
        "Prefer `get_stop_realtime` for a **single stop** where you need both a map block and a structured arrival list. " +
        "Prefer `get_stop_geometry` when you only need static route polylines without live data. " +
        "Requires at least one numeric stop ID (visible on stop signage); call `get_stops_around_location` first if you only have coordinates.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_ids: z.array(zStopId()).min(1).describe("One or more stop ids to aggregate."),
      },
    },
    async ({ stop_ids }) => {
      const stopCodes = [...new Set(stop_ids.map((stopId) => normalizeStopCode(stopId)))];
      const stops = [];
      const vehiclesById = new Map();

      for (const stopCode of stopCodes) {
        const actionResult = await runAction(getSingleStopAction, {
          stopCode,
          query: { skipTimetableData: "false" },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_vehicles_by_stop", actionResult);
        }

        const body = actionResult.body ?? {};
        const stop = {
          id: String(body.code),
          name: body.name ?? null,
          lat: normalizeCoordinate(body.latitude),
          lng: normalizeCoordinate(body.longitude),
        };
        stops.push(stop);

        const realtimeArrivals = Array.isArray(body.timetable)
          ? body.timetable.map((item) => normalizeRealtimeArrival(item))
          : [];
        realtimeArrivals.forEach((arrival, index) => {
          const vehicle = {
            id: arrival.vehicle_id ?? `vehicle-${stop.id}-${index + 1}`,
            route: arrival.route,
            lat: arrival.lat,
            lng: arrival.lng,
            bearing: arrival.bearing,
            next_stop_id: stop.id,
            eta_minutes: arrival.arrival_minutes,
          };
          const existing = vehiclesById.get(vehicle.id);
          if (!existing) {
            vehiclesById.set(vehicle.id, vehicle);
            return;
          }
          if (existing.eta_minutes === null && vehicle.eta_minutes !== null) {
            vehiclesById.set(vehicle.id, vehicle);
            return;
          }
          if (
            existing.eta_minutes !== null &&
            vehicle.eta_minutes !== null &&
            vehicle.eta_minutes < existing.eta_minutes
          ) {
            vehiclesById.set(vehicle.id, vehicle);
          }
        });
      }

      return formatToolResult("get_vehicles_by_stop", {
        statusCode: 200,
        body: {
          stop_ids: stopCodes.map(String),
          stops,
          vehicles: [...vehiclesById.values()],
          updated_at: new Date().toISOString(),
        },
      });
    },
  );

  server.registerTool(
    "get_stop_geometry",
    {
      title: "Get Stop Geometry",
      description:
        "Returns static map context for a stop: its marker and polylines for every route that serves it. No live data is fetched. " +
        "Use this when you need to enrich an existing map with route shapes (e.g. overlay polylines alongside a `get_stop_realtime` map block) or when the user asks to visualise which routes pass a stop without needing live arrivals. " +
        "Do NOT use this when live arrival times or vehicle positions are needed — use `get_stop_realtime` instead. " +
        "Requires a numeric stop ID; call `get_stops_around_location` first if you only have coordinates.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_id: zStopId(),
      },
    },
    async ({ stop_id }) => {
      const stopCode = normalizeStopCode(stop_id);
      const stopResult = await runAction(getSingleStopAction, {
        stopCode,
        query: { skipTimetableData: "true" },
      });
      if (stopResult.statusCode >= 400) {
        return formatToolResult("get_stop_geometry", stopResult);
      }

      const stopBody = stopResult.body ?? {};
      const stop = {
        id: String(stopBody.code),
        name: stopBody.name ?? null,
        lat: normalizeCoordinate(stopBody.latitude),
        lng: normalizeCoordinate(stopBody.longitude),
      };

      const routeNames = [...new Set(
        (Array.isArray(stopBody.transfers) ? stopBody.transfers : [])
          .map((transfer) => transfer.route)
          .filter((route) => typeof route === "string" && route.length > 0),
      )];

      const routes = [];
      for (const routeName of routeNames) {
        const routeResult = await runAction(routeInfoStaticAction, {
          params: { name: routeName },
        });
        if (routeResult.statusCode >= 400) {
          continue;
        }

        const routeBody = routeResult.body ?? {};
        const shapes = Array.isArray(routeBody.shapes) ? routeBody.shapes : [];
        const polyline = shapes.find((shape) => Array.isArray(shape) && shape.length > 0) ?? [];
        routes.push({
          route: routeName,
          polyline,
        });
      }

      return formatToolResult("get_stop_geometry", {
        statusCode: 200,
        body: {
          stop,
          routes,
          updated_at: new Date().toISOString(),
        },
      });
    },
  );

  server.registerTool(
    "get_stops_around_location",
    {
      title: "Get Stops Around Location",
      description:
        "Discovers transit stops near a geographic point, returning each stop's numeric code, name, coordinates, and walking distance. Also emits a map UI block with multiple markers for map-capable clients (e.g. ChatGPT). " +
        "Use this as the **first step** whenever the user provides an address, place name, or coordinates and you need stop IDs before calling `get_stop_realtime`, `get_vehicles_by_stop`, or `get_stop_geometry`. " +
        "Do NOT use this to fetch arrivals or live vehicle data — it returns stop metadata only. " +
        "Default radius is 1 000 m; narrow it (e.g. 300 m) for dense urban areas or widen it (up to 3 000 m) for rural locations.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: z.number().min(-90).max(90).describe("Center latitude (WGS84)."),
        longitude: z.number().min(-180).max(180).describe("Center longitude (WGS84)."),
        radius_meters: z
          .number()
          .int()
          .min(50)
          .max(3000)
          .optional()
          .describe("Search radius in meters (default 1000; same cap as the public /closest API)."),
      },
    },
    async ({ latitude, longitude, radius_meters }) => {
      const query = {
        latitude: String(latitude),
        longitude: String(longitude),
      };
      if (radius_meters != null) {
        query.radius = String(radius_meters);
      }

      const actionResult = await runAction(getClosestStopsAction, { query });
      if (actionResult.statusCode >= 400) {
        return formatToolResult("get_stops_around_location", actionResult);
      }

      const rows = Array.isArray(actionResult.body) ? actionResult.body : [];
      const effectiveRadius = radius_meters ?? 1000;

      const stops = rows.map((s) => ({
        id: String(s.code),
        name: s.name ?? null,
        lat: normalizeCoordinate(s.latitude),
        lng: normalizeCoordinate(s.longitude),
        distance_meters: Number.isFinite(s.distance_meters) ? s.distance_meters : null,
      }));

      const payload = {
        center_lat: normalizeCoordinate(latitude),
        center_lng: normalizeCoordinate(longitude),
        radius_meters: effectiveRadius,
        stops,
        updated_at: new Date().toISOString(),
      };

      return formatToolResult("get_stops_around_location", {
        statusCode: 200,
        body: payload,
      });
    },
  );
}

function registerPrompts(server) {
  server.registerPrompt(
    "transit-map-view",
    {
      title: "Transit Map View",
      description:
        "Render live vehicles on map for a stop.",
      argsSchema: {
        stop_id: zStopId(),
      },
    },
    ({ stop_id }) => ({
      description: "Map-first prompt for live transit vehicles.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Show live transport map for stop ${stop_id} in Lviv.`,
              "",
              "Tool workflow:",
              `1) Call \`get_stop_realtime\` with \`stop_id=${stop_id}\`.`,
              `2) Optionally call \`get_stop_geometry\` with \`stop_id=${stop_id}\` and merge route polylines into the map block.`,
              "",
              "Output format:",
              "- Return strict JSON only.",
              "- Always output `ui_blocks` with `map` as the first block.",
              "- Include ETA labels from tool data for each mapped vehicle.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "transit-arrival-list",
    {
      title: "Transit Arrival List",
      description:
        "Render upcoming arrivals list for a stop.",
      argsSchema: {
        stop_id: zStopId(),
      },
    },
    ({ stop_id }) => ({
      description: "Arrival-list focused prompt for realtime stop data.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Show an arrival list for stop ${stop_id} in Lviv.`,
              "",
              "Tool workflow:",
              `1) Call \`get_stop_realtime\` with \`stop_id=${stop_id}\`.`,
              "",
              "Output format:",
              "- Return strict JSON only.",
              "- Ensure `arrival_list` block is present.",
              "- Sort arrivals by `arrival_minutes` ascending.",
              "- Group repeated routes logically in the rendered list.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "transit-hybrid-view",
    {
      title: "Transit Hybrid View",
      description:
        "Render map and arrival list together with synchronized ETA values.",
      argsSchema: {
        stop_id: zStopId(),
      },
    },
    ({ stop_id }) => ({
      description: "Hybrid map + arrival list prompt with strict block order.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Build hybrid realtime transit view for stop ${stop_id}.`,
              "",
              "Tool workflow:",
              `1) Call \`get_stop_realtime\` with \`stop_id=${stop_id}\`.`,
              `2) Optionally call \`get_stop_geometry\` with \`stop_id=${stop_id}\` and merge route polylines.`,
              "",
              "Output format:",
              "- Return strict JSON only.",
              "- Always output `ui_blocks` with first block `map`, second block `arrival_list`.",
              "- Ensure route labels and ETA values are consistent across both blocks.",
              "- Any map vehicle without ETA must include `eta_status: \"unassigned\"`.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

export function createTimetableMcpServer() {
  const server = new McpServer(
    mcpServerImplementation(),
    {
      capabilities: {
        logging: {},
      },
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.server.setRequestHandler(PingRequestSchema, () => ({}));

  registerTools(server);
  registerResources(server);
  registerPrompts(server);
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
  const svgIconUrl = new URL("mcp-icon.svg", `${normalizedBaseUrl}/`).href;
  const faviconUrl = new URL("favicon.ico", `${normalizedBaseUrl}/`).href;

  const serverInfo = {
    name: MCP_SERVER_INFO.name,
    version: MCP_SERVER_INFO.version,
    title: MCP_SERVER_INFO.title,
    description: MCP_SERVER_INFO.description,
    websiteUrl: MCP_SERVER_INFO.websiteUrl,
    icons: [
      { src: svgIconUrl, mimeType: "image/svg+xml" },
      { src: faviconUrl, mimeType: "image/x-icon" },
    ],
  };

  // Smithery static card: serverInfo; registry-style keys (description, homepage, iconUrl) at top level
  // for tools that do not read MCP's websiteUrl/Implementation only.
  return {
    serverInfo,
    name: serverInfo.name,
    version: serverInfo.version,
    title: serverInfo.title,
    description: serverInfo.description,
    websiteUrl: serverInfo.websiteUrl,
    homepage: serverInfo.websiteUrl,
    iconUrl: svgIconUrl,
    icon: svgIconUrl,
    icons: serverInfo.icons,
    remotes: [
      {
        type: "streamable-http",
        url: `${normalizedBaseUrl}/mcp`,
      },
    ],
    authentication: {
      type: "none",
    },
    registryUrl:
      "https://registry.modelcontextprotocol.io/v0/servers/io.github.vbhjckfd%2Ftimetable-api-node/versions",
    configSchema: SMITHERY_CONFIG_JSON_SCHEMA,
  };
}
