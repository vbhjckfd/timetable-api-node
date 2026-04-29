import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import getSingleStopAction from "../actions/getSingleStopAction.js";
import getClosestStopsAction from "../actions/getClosestStopsAction.js";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.js";
import routeDynamicInfoAction from "../actions/routeDynamicInfoAction.js";

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

const MCP_SERVER_INSTRUCTIONS = `\
Lviv, Ukraine public transport assistant. Read-only. No authentication required.

## Tool selection

- User asks about arrivals or "when is the next bus/tram at stop X" → \`get_stop_realtime\`
- User asks "where is route X right now" or wants live vehicle positions on a route → \`get_route_realtime\`
- User asks which stops a route serves, wants a route map, or asks about departure times → \`get_route_static\`
- User needs route polylines overlaid on an existing map (no live data needed) → \`get_stop_geometry\`
- User provides an address or coordinates instead of a stop ID → \`get_stops_around_location\` first, then use the returned stop IDs

## Input conventions

- Stop IDs are **numeric codes** printed on physical stop signage (e.g. 707). Accept both integer and digits-only string.
- Route names are **short names** as shown on vehicles and stops (e.g. "T30", "32A"). Numeric external IDs are also accepted.
- Never guess a stop ID from a place name — always call \`get_stops_around_location\` first when only an address or coordinates are given.

## UI contract

Every tool response is a JSON object with three top-level keys:
- \`view\` — always \`"transit_realtime"\`
- \`data\` — the raw structured payload (use for text summaries and extraction)
- \`ui_blocks\` — ordered rendering hints for map-capable clients; process in array order

Block types:
- \`map\` — render a map centred on \`data.center [lat, lng]\` at \`data.zoom\`. Plot \`stops\` as markers, \`vehicles\` as moving icons with \`bearing\`, \`polylines\` as route shapes.
- \`arrival_list\` — render arrivals sorted by \`arrival_minutes\` ascending. Show \`route\`, \`direction\`, \`vehicle_type\`, and ETA. Vehicles with no ETA have \`eta_status: "unassigned"\`.

Consistency rule: every vehicle shown on a map must either match an arrival in the list (by \`vehicle_id\`) or carry \`eta_status: "unassigned"\`.

## Data caveats

- Live positions and ETAs come from upstream GTFS-RT feeds; occasional gaps or stale positions are expected.
- \`get_route_static\` departure times (\`departures\`) are only populated for direction 0 (outbound).
- \`direction\` in \`get_route_realtime\` vehicles corresponds to the index into \`get_route_static\`'s \`stops\` array (0 = outbound, 1 = return).
`;

function zRouteName() {
  return z
    .string()
    .min(1)
    .describe("Route short name (e.g. \"T30\", \"32A\") or numeric external ID.");
}

function zStopId() {
  return z
    .union([
      z
        .number()
        .int()
        .positive()
        .describe("Positive integer stop code (e.g. 707)."),
      z
        .string()
        .regex(/^\d+$/)
        .describe("Stop code as a digits-only string (e.g. \"707\")."),
    ])
    .describe(
      "Municipal stop code shown on stop signage (e.g. 707). Accepts a positive integer or an equivalent digit-only string.",
    );
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

  if (toolName === "get_route_static") {
    const dirStops = Array.isArray(payload.stops) ? payload.stops : [];
    const allStops = dirStops.flat().map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
    }));
    const firstStop = (dirStops[0] ?? [])[0] ?? null;
    const shapes = Array.isArray(payload.shapes)
      ? payload.shapes.filter((s) => Array.isArray(s) && s.length > 0)
      : [];
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [firstStop?.lat ?? null, firstStop?.lng ?? null],
            zoom: 13,
            polylines: shapes,
            stops: allStops,
            vehicles: [],
          },
        },
      ],
    };
  }

  if (toolName === "get_route_realtime") {
    const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];
    const firstVehicle = vehicles[0] ?? null;
    return {
      view: "transit_realtime",
      data: payload,
      ui_blocks: [
        {
          type: "map",
          data: {
            center: [firstVehicle?.lat ?? null, firstVehicle?.lng ?? null],
            zoom: 13,
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

Read-only access to **public** timetable and live vehicle data for municipal transit in **Lviv, Ukraine** (lad.lviv.ua ecosystem). No authentication required.

### Tool selection

| Situation | Tool |
|-----------|------|
| "When is the next bus/tram at stop X?" | \`get_stop_realtime\` |
| "Where is route X right now?" / live vehicle positions on a route | \`get_route_realtime\` |
| Which stops does a route serve? / route shape on map / departure times | \`get_route_static\` |
| Overlay route polylines on a map (no live data needed) | \`get_stop_geometry\` |
| Only have an address or coordinates, need a stop ID | \`get_stops_around_location\` → then use returned stop IDs |

### Input conventions

- **Stop IDs** are numeric codes printed on physical stop signage (e.g. \`707\`). Accept integer or digits-only string.
- **Route names** are short names as shown on vehicles (e.g. \`"T30"\`, \`"32A"\`). Numeric external IDs also work.
- Never guess a stop ID — call \`get_stops_around_location\` whenever only an address or coordinates are provided.

### UI contract

Every tool result is JSON with three keys: \`view\`, \`data\`, and \`ui_blocks\`.

- \`data\` — raw structured payload; use for text summaries and value extraction.
- \`ui_blocks\` — ordered rendering hints. Process in array order.
  - \`map\` block: render centred on \`center [lat, lng]\` at \`zoom\`. Plot \`stops\` as markers, \`vehicles\` as directional icons, \`polylines\` as route shapes.
  - \`arrival_list\` block: render arrivals sorted by \`arrival_minutes\` ascending. Show \`route\`, \`direction\`, \`vehicle_type\`, ETA. Missing ETA → \`eta_status: "unassigned"\`.
- Consistency rule: every vehicle on the map must either match an arrival in the list (by \`vehicle_id\`) or have \`eta_status: "unassigned"\`.

### How to work with this server

- Prefer **tools** for live structured data.
- Use **prompts** (\`transit-map-view\`, \`transit-arrival-list\`, \`transit-hybrid-view\`) for ready-made rendering workflows.
- Use **resources** (\`timetable://about\`, \`timetable://reference/tools\`, \`timetable://reference/prompts\`) for reference without calling tools.

### Data caveats

- Live positions and ETAs come from upstream GTFS-RT feeds; occasional gaps or stale values are expected.
- \`get_route_static\` departure times are only populated for direction 0 (outbound).
- \`direction\` in \`get_route_realtime\` vehicles maps to the index into \`get_route_static\`'s \`stops\` array (0 = outbound, 1 = return).
`,

  tools: `## Tools reference

| Tool | Purpose |
|------|---------|
| \`get_stop_realtime\` | Realtime arrivals and live vehicles for a stop; includes map + arrival-list UI blocks. |
| \`get_route_static\` | Route metadata, stop lists for both directions, departure times, and polylines for map rendering. |
| \`get_route_realtime\` | Live vehicle positions for all vehicles currently running on a route; map UI block. |
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
        "Returns live arrivals and vehicle positions for a stop, producing both a map UI block and a structured arrival list. " +
        "Use this as the **default tool** when the user asks about arrivals, departures, or vehicles at a specific stop. " +
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
    "get_route_static",
    {
      title: "Get Route Static",
      description:
        "Returns static route metadata: short and long name, vehicle type, brand colour, ordered stop lists for both directions, and route polylines (shapes) for map rendering. " +
        "Use when the user asks which stops a route serves, what a route looks like on a map, or what the scheduled departure times are. " +
        "Do NOT use this when live vehicle positions are needed — use `get_route_realtime` instead. " +
        "Requires a route short name (e.g. \"T30\", \"32A\") or numeric external ID; call `get_stops_around_location` first if you only know a location and need to discover which routes serve it.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeInfoStaticAction, {
        params: { name: route_name },
      });
      if (actionResult.statusCode >= 400) {
        return formatToolResult("get_route_static", actionResult);
      }

      const body = actionResult.body ?? {};
      const payload = {
        route: {
          name: body.route_short_name ?? null,
          long_name: body.route_long_name ?? null,
          color: body.color ?? null,
          type: body.type ?? null,
        },
        stops: (Array.isArray(body.stops) ? body.stops : []).map((dirStops) =>
          (Array.isArray(dirStops) ? dirStops : []).map((s) => ({
            id: String(s.code),
            name: s.name ?? null,
            lat: normalizeCoordinate(s.loc?.[0]),
            lng: normalizeCoordinate(s.loc?.[1]),
            departures: Array.isArray(s.departures) ? s.departures : [],
          })),
        ),
        shapes: Array.isArray(body.shapes) ? body.shapes : [],
        updated_at: new Date().toISOString(),
      };

      return formatToolResult("get_route_static", { statusCode: 200, body: payload });
    },
  );

  server.registerTool(
    "get_route_realtime",
    {
      title: "Get Route Realtime",
      description:
        "Returns live positions for all vehicles currently running on a route, optimised for map rendering. " +
        "Use when the user asks \"where is my tram/bus right now?\" or wants to see all active vehicles on a specific route on a map. " +
        "Prefer `get_stop_realtime` when the user is at a stop and wants to know arrival times rather than vehicle positions. " +
        "Prefer `get_route_static` when only the route shape or stop list is needed without live data. " +
        "Requires a route short name (e.g. \"T30\", \"32A\") or numeric external ID.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
      },
    },
    async ({ route_name }) => {
      const actionResult = await runAction(routeDynamicInfoAction, {
        params: { name: route_name },
      });
      if (actionResult.statusCode >= 400) {
        return formatToolResult("get_route_realtime", actionResult);
      }

      const rawVehicles = Array.isArray(actionResult.body) ? actionResult.body : [];
      const payload = {
        route_name,
        vehicles: rawVehicles.map((v, index) => ({
          id: v.id ?? `vehicle-${index + 1}`,
          direction: v.direction ?? null,
          lat: normalizeCoordinate(v.location?.[0]),
          lng: normalizeCoordinate(v.location?.[1]),
          bearing: normalizeBearing(v.bearing),
          lowfloor: v.lowfloor ?? null,
        })),
        updated_at: new Date().toISOString(),
      };

      return formatToolResult("get_route_realtime", { statusCode: 200, body: payload });
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
        "Use this as the **first step** whenever the user provides an address, place name, or coordinates and you need stop IDs before calling `get_stop_realtime` or `get_stop_geometry`. " +
        "Do NOT use this to fetch arrivals or live vehicle data — it returns stop metadata only. " +
        "Default radius is 1 000 m; narrow it (e.g. 300 m) for dense urban areas or widen it (up to 3 000 m) for rural locations.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: z
          .number()
          .min(-90)
          .max(90)
          .describe("Decimal latitude of the search centre, WGS84 (e.g. 49.842 for central Lviv)."),
        longitude: z
          .number()
          .min(-180)
          .max(180)
          .describe("Decimal longitude of the search centre, WGS84 (e.g. 24.031 for central Lviv)."),
        radius_meters: z
          .number()
          .int()
          .min(50)
          .max(3000)
          .optional()
          .describe(
            "Search radius in metres (50–3000, default 1000). Use ~300 for dense urban intersections, up to 3000 for suburban or rural areas.",
          ),
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
