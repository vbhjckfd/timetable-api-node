import * as Sentry from "@sentry/node";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import getSingleStopAction from "../actions/getSingleStopAction.js";
import getClosestStopsAction from "../actions/getClosestStopsAction.js";
import closestTransportAction from "../actions/closestTransportAction.js";
import vehicleInfoAction from "../actions/vehicleInfoAction.js";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.js";
import routeDynamicInfoAction from "../actions/routeDynamicInfoAction.js";
import {
  destinationsFor,
  findRoutesBetween,
  nextStopsForVehicles,
  PASSED_GRACE_MS,
  resolveRoute,
  searchStops,
} from "../services/transitLookupService.js";
import { distanceMeters, formatRouteName } from "../utils/appHelpers.js";

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Exposed in MCP `initialize` and in `/.well-known/mcp/server-card.json` (Smithery, client UIs). */
const MCP_SERVER_INFO = {
  name: "com.lad.lviv/timetable-api",
  title: "Lviv Timetable MCP",
  version: pkg.version,
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
  exampleConfig: { default_language: "any" },
};

/**
 * Shared tool-selection/UI-contract/data-caveat guidance. Reused verbatim by both
 * MCP_SERVER_INSTRUCTIONS (sent as the MCP `instructions` field) and the `timetable://about`
 * resource, so the two never drift out of sync.
 */
const TRANSIT_ASSISTANT_GUIDANCE = `\
## Tool selection

- User names a stop ("Опера", "Rynok", "Головний вокзал") → \`search_stops\` to get its stop ID
- User gives an address or coordinates → \`get_stops_around_location\` to get nearby stop IDs
- User asks about arrivals or "when is the next bus/tram at stop X" → \`get_stop_realtime\`
- User asks how to get from A to B → resolve both stops, then \`find_routes_between\`; then \`get_stop_realtime\` on the boarding stop for live times
- User asks "where is route X right now" or how many vehicles run on it → \`get_route_realtime\`
- User asks which stops a route serves, where it goes, or its timetable → \`get_route_static\` (\`include_shapes: true\` only for drawing a map)
- User asks "what vehicles are near me" → \`get_nearby_vehicles\` (filter with \`route\` when relevant)
- User wants to follow one vehicle by ID → \`get_vehicle_info\`

## Input conventions

- Stop IDs are **numeric codes** printed on physical stop signage (e.g. 707). Accept both integer and digits-only string.
- Route names are **short names** as shown on vehicles and stops (e.g. "Т30", "А1"); Latin letters ("T30", "A01") work too. Numeric external IDs are also accepted, so a bare number is not a route name.
- Never guess a stop ID from a place name — resolve it with \`search_stops\` or \`get_stops_around_location\` first.
- One stop name usually covers both sides of the street under different IDs; each direction stops on one of them. The \`routes\` list on each stop tells them apart.

## UI contract

Every tool response is a JSON object with three top-level keys:
- \`view\` — always \`"transit_realtime"\`
- \`data\` — the structured payload; answer from this
- \`ui_blocks\` — ordered rendering hints for map-capable clients; process in array order. Blocks point into \`data\` rather than repeating it.

Block types:
- \`map\` — render a map centred on \`center [lat, lng]\` at \`zoom\`. \`layers\` maps \`stops\`, \`vehicles\` and \`polylines\` to a dot path in the result (e.g. \`"data.arrivals"\`); plot what each path holds. Every stop and vehicle there has \`lat\`/\`lng\`; vehicles also have \`bearing\`.
- \`arrival_list\` — render the arrivals at \`source\`, already sorted by \`arrival_minutes\`. Show \`route\`, \`direction\` (destination), \`vehicle_type\`, and ETA; a \`null\` \`arrival_minutes\` means no ETA.

## Data caveats

- Live positions and ETAs come from upstream GTFS-RT feeds; occasional gaps or stale positions are expected.
- \`get_route_static\` departure times (\`departures\` and \`schedule.workday\`/\`schedule.weekend\`) are only populated for the first stop of each direction.
- \`direction\` is the index into \`get_route_static\`'s \`stops\` array (0 = outbound, 1 = return); \`destination\` is the name of that direction's last stop.
- \`find_routes_between\` covers direct routes only; an empty result means a transfer is needed.
`;

const MCP_SERVER_INSTRUCTIONS = `\
Lviv, Ukraine public transport assistant. Read-only. No authentication required.

${TRANSIT_ASSISTANT_GUIDANCE}`;

function zRouteName() {
  return z
    .string()
    .min(1)
    .describe("Route short name (e.g. \"T30\", \"32A\") or numeric external ID.");
}

/**
 * Coercion rather than a number|string union on purpose: a union publishes
 * `anyOf` in the tool inputSchema, which several tool-calling stacks (OpenAI
 * strict function schemas among them) reject or silently degrade. `z.coerce`
 * emits a plain `{"type":"integer"}` and still accepts "707" at call time.
 */
function zStopId() {
  return z.coerce
    .number()
    .int()
    .positive()
    .describe(
      "Municipal stop code shown on stop signage (e.g. 707). Accepts a positive integer or an equivalent digit-only string.",
    );
}

const zCoord = z.number().nullable();
const zStopObj = z.object({ id: z.string(), name: z.string().nullable(), lat: zCoord, lng: zCoord });
const zStopWithRoutes = zStopObj.extend({ routes: z.array(z.string()) });
const zArrivalObj = z.object({
  route: z.string().nullable(),
  direction: z.string().nullable(),
  vehicle_type: z.string().nullable(),
  arrival_minutes: z.number().int().nullable(),
  vehicle_id: z.string().nullable(),
  lat: zCoord,
  lng: zCoord,
  bearing: z.number().nullable(),
});
const zNextStop = z.object({ id: z.string(), name: z.string().nullable(), arrival: z.string() }).nullable();
const zCenter = z.tuple([zCoord, zCoord]);

/**
 * ui_blocks point into `data` instead of repeating it: every tool result is
 * read by a model, and copying each vehicle and stop into a map block used to
 * make up roughly half of every payload. A layer is a dot path from the
 * structured result root (e.g. "data.arrivals").
 */
const zMapBlock = z.object({
  type: z.literal("map"),
  data: z.object({
    center: zCenter,
    zoom: z.number(),
    layers: z.object({
      stops: z.string().optional(),
      vehicles: z.string().optional(),
      polylines: z.string().optional(),
    }),
  }),
});
const zArrivalListBlock = z.object({
  type: z.literal("arrival_list"),
  data: z.object({ source: z.string() }),
});

const transitResult = (data, uiBlock = zMapBlock) =>
  z.object({
    view: z.literal("transit_realtime"),
    data,
    ui_blocks: z.array(uiBlock),
  });

const OUTPUT_SCHEMAS = {
  get_stop_realtime: transitResult(
    z.object({ stop: zStopObj, arrivals: z.array(zArrivalObj), updated_at: z.string() }),
    z.discriminatedUnion("type", [zMapBlock, zArrivalListBlock]),
  ),
  get_route_static: transitResult(z.object({
    route: z.object({
      name: z.string().nullable(),
      long_name: z.string().nullable(),
      color: z.string().nullable(),
      type: z.string().nullable(),
    }),
    stops: z.array(z.array(zStopObj.extend({
      departures: z.array(z.string()),
      schedule: z.object({ workday: z.array(z.string()), weekend: z.array(z.string()) }).optional(),
    }))),
    shapes: z.array(z.array(z.array(z.number()))).optional(),
    updated_at: z.string(),
  })),
  get_route_realtime: transitResult(z.object({
    route_name: z.string(),
    destinations: z.array(z.string().nullable()),
    vehicles: z.array(z.object({
      id: z.string(),
      direction: z.number().int().nullable(),
      destination: z.string().nullable(),
      next_stop: zNextStop,
      lat: zCoord,
      lng: zCoord,
      bearing: z.number().nullable(),
      lowfloor: z.boolean().nullable(),
    })),
    updated_at: z.string(),
  })),
  get_stops_around_location: transitResult(z.object({
    center_lat: zCoord,
    center_lng: zCoord,
    radius_meters: z.number(),
    stops: z.array(zStopWithRoutes.extend({ distance_meters: z.number().nullable() })),
    updated_at: z.string(),
  })),
  search_stops: transitResult(z.object({
    query: z.string(),
    stops: z.array(zStopWithRoutes.extend({ eng_name: z.string().nullable() })),
    updated_at: z.string(),
  })),
  find_routes_between: transitResult(z.object({
    from: z.object({ id: z.string(), name: z.string().nullable(), stop_ids: z.array(z.string()) }),
    to: z.object({ id: z.string(), name: z.string().nullable(), stop_ids: z.array(z.string()) }),
    options: z.array(z.object({
      route: z.string(),
      vehicle_type: z.string(),
      direction: z.number().int(),
      destination: z.string().nullable(),
      board_stop: zStopObj,
      alight_stop: zStopObj,
      stops_count: z.number().int(),
      walk_to_board_meters: z.number().int(),
      walk_from_alight_meters: z.number().int(),
    })),
    updated_at: z.string(),
  })),
  get_nearby_vehicles: transitResult(z.object({
    center_lat: zCoord,
    center_lng: zCoord,
    radius_meters: z.number(),
    total: z.number().int(),
    vehicles: z.array(z.object({
      id: z.string().nullable(),
      route: z.string().nullable(),
      vehicle_type: z.string().nullable(),
      direction: z.number().int().nullable(),
      destination: z.string().nullable(),
      lat: zCoord,
      lng: zCoord,
      bearing: z.number().nullable(),
      lowfloor: z.boolean().nullable(),
      distance_meters: z.number().nullable(),
    })),
    updated_at: z.string(),
  })),
  get_vehicle_info: transitResult(z.object({
    vehicle_id: z.string(),
    route: z.string().nullable(),
    license_plate: z.string().nullable(),
    lat: zCoord,
    lng: zCoord,
    bearing: z.number().nullable(),
    direction: z.number().int().nullable(),
    destination: z.string().nullable(),
    upcoming_stops: z.array(z.object({
      id: z.string(),
      name: z.string().nullable(),
      arrival: z.string().nullable(),
      departure: z.string().nullable(),
    })),
    updated_at: z.string(),
  })),
};

// --- In-process TTL cache ---

const _toolCache = new Map();
const CACHE_TTL_MS = {
  get_stop_realtime: 10_000,
  get_route_realtime: 10_000,
  get_nearby_vehicles: 10_000,
  get_vehicle_info: 5_000,
  get_stops_around_location: 60_000,
  get_route_static: 5 * 60_000,
  search_stops: 5 * 60_000,
  find_routes_between: 5 * 60_000,
};

function getCached(toolName, args) {
  const key = `${toolName}:${JSON.stringify(args)}`;
  const entry = _toolCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    _toolCache.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Entries are only ever evicted when their own key is read again, so a stream
 * of one-shot keys (vehicle IDs, arbitrary coordinates) would grow the map
 * forever on a long-lived instance. Cap it and sweep on insert.
 */
const MAX_CACHE_ENTRIES = 500;

function setCached(toolName, args, value) {
  const ttl = CACHE_TTL_MS[toolName] ?? 10_000;
  const now = Date.now();

  if (_toolCache.size >= MAX_CACHE_ENTRIES) {
    for (const [key, entry] of _toolCache) {
      if (now > entry.expiresAt) _toolCache.delete(key);
    }
    // Everything still live: drop the least recently written keys.
    while (_toolCache.size >= MAX_CACHE_ENTRIES) {
      _toolCache.delete(_toolCache.keys().next().value);
    }
  }

  const key = `${toolName}:${JSON.stringify(args)}`;
  // Re-insert so Map iteration order tracks write recency.
  _toolCache.delete(key);
  _toolCache.set(key, { value, expiresAt: now + ttl });
}

// --- Normalizers ---

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
    direction: entry.end_stop ?? (typeof entry.direction === "string" ? entry.direction : null),
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

// --- Natural-language text summaries (replaces full JSON dump) ---

const plural = (count, word) => `${count} ${word}${count !== 1 ? "s" : ""}`;

function buildTextSummary(toolName, structured) {
  const { data } = structured;
  switch (toolName) {
    case "get_stop_realtime": {
      const stopName = data.stop?.name ?? `#${data.stop?.id}`;
      const count = data.arrivals?.length ?? 0;
      if (count === 0) return `Stop «${stopName}»: no arrivals found.`;
      const next = data.arrivals[0];
      const eta = next.arrival_minutes != null ? `${next.arrival_minutes} min` : "soon";
      return `Stop «${stopName}»: ${plural(count, "arrival")}. Next: ${next.route ?? "?"} → «${next.direction ?? "?"}» in ${eta}.`;
    }
    case "get_route_static": {
      const name = data.route?.name ?? "?";
      const longName = data.route?.long_name;
      const d0 = data.stops?.[0]?.length ?? 0;
      const d1 = data.stops?.[1]?.length ?? 0;
      return `Route ${name}${longName ? ` (${longName})` : ""}: ${d0} outbound stops, ${d1} inbound stops.`;
    }
    case "get_route_realtime": {
      const count = data.vehicles?.length ?? 0;
      const byDestination = Object.entries(
        (data.vehicles ?? []).reduce((acc, v) => {
          if (v.destination) acc[v.destination] = (acc[v.destination] ?? 0) + 1;
          return acc;
        }, {}),
      ).map(([destination, n]) => `${n} → «${destination}»`);
      return `Route ${data.route_name}: ${plural(count, "active vehicle")}${byDestination.length ? ` (${byDestination.join(", ")})` : ""}.`;
    }
    case "get_stops_around_location": {
      const count = data.stops?.length ?? 0;
      if (count === 0) return `No stops found within ${data.radius_meters}m.`;
      const nearest = data.stops[0];
      return `${plural(count, "stop")} within ${data.radius_meters}m. Nearest: «${nearest.name}» (code ${nearest.id}, ${nearest.distance_meters ?? "?"}m).`;
    }
    case "search_stops": {
      const count = data.stops?.length ?? 0;
      if (count === 0) return `No stops match «${data.query}».`;
      const list = data.stops.slice(0, 5).map((s) => `«${s.name}» (${s.id})`).join(", ");
      return `${plural(count, "stop")} match «${data.query}»: ${list}${count > 5 ? ", …" : ""}.`;
    }
    case "find_routes_between": {
      const count = data.options?.length ?? 0;
      const trip = `«${data.from?.name ?? "?"}» → «${data.to?.name ?? "?"}»`;
      if (count === 0) return `No direct route ${trip}; a transfer is needed.`;
      const best = data.options[0];
      const walk = best.walk_to_board_meters ? `, board at «${best.board_stop.name}» (${best.walk_to_board_meters}m walk)` : "";
      return `${plural(count, "direct route")} ${trip}. Best: ${best.route} towards «${best.destination ?? "?"}», ${plural(best.stops_count, "stop")}${walk}.`;
    }
    case "get_nearby_vehicles": {
      const count = data.vehicles?.length ?? 0;
      if (count === 0) return `No vehicles within ${data.radius_meters}m.`;
      const routes = [...new Set(data.vehicles.map((v) => v.route).filter(Boolean))].join(", ");
      const shown = data.total > count ? ` (nearest ${count} of ${data.total})` : "";
      return `${plural(count, "vehicle")} within ${data.radius_meters}m${shown}. Routes: ${routes || "?"}.`;
    }
    case "get_vehicle_info": {
      const upcoming = data.upcoming_stops?.length ?? 0;
      const towards = data.destination ? ` towards «${data.destination}»` : "";
      const next = data.upcoming_stops?.[0]?.name ? ` Next stop: «${data.upcoming_stops[0].name}».` : "";
      return `Vehicle ${data.vehicle_id} on route ${data.route ?? "?"}${towards} (plate: ${data.license_plate ?? "unknown"}). ${plural(upcoming, "upcoming stop")}.${next}`;
    }
    default:
      return `${toolName}: data retrieved.`;
  }
}

// --- UI payload builder ---

const mapBlock = (center, zoom, layers) => ({
  type: "map",
  data: { center: center.map((v) => normalizeCoordinate(v)), zoom, layers },
});

/** Map blocks carry only what `data` lacks: where to centre, how far to zoom, and which arrays to plot. */
function buildUiBlocks(toolName, data) {
  switch (toolName) {
    case "get_stop_realtime":
      return [
        mapBlock([data.stop?.lat, data.stop?.lng], 14, { stops: "data.stop", vehicles: "data.arrivals" }),
        { type: "arrival_list", data: { source: "data.arrivals" } },
      ];
    case "get_route_static": {
      const first = data.stops?.[0]?.[0];
      return [
        mapBlock([first?.lat, first?.lng], 13, {
          stops: "data.stops",
          ...(data.shapes ? { polylines: "data.shapes" } : {}),
        }),
      ];
    }
    case "get_route_realtime": {
      const first = data.vehicles?.[0];
      return [mapBlock([first?.lat, first?.lng], 13, { vehicles: "data.vehicles" })];
    }
    case "get_stops_around_location":
      return [
        mapBlock([data.center_lat, data.center_lng], data.radius_meters > 1500 ? 14 : 15, { stops: "data.stops" }),
      ];
    case "search_stops": {
      const first = data.stops?.[0];
      return data.stops?.length ? [mapBlock([first.lat, first.lng], 14, { stops: "data.stops" })] : [];
    }
    case "get_nearby_vehicles":
      return [mapBlock([data.center_lat, data.center_lng], 15, { vehicles: "data.vehicles" })];
    case "get_vehicle_info":
      return [mapBlock([data.lat, data.lng], 15, { vehicles: "data" })];
    default:
      return [];
  }
}

function buildUiPayload(toolName, data) {
  return {
    view: "transit_realtime",
    data: data ?? {},
    ui_blocks: buildUiBlocks(toolName, data ?? {}),
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

const toolError = (text) => ({ isError: true, content: [{ type: "text", text }] });

/**
 * A bare 404 tells the model nothing it can act on. These say what to try
 * next; any other failure keeps the action's own message.
 */
const NOT_FOUND_HINTS = {
  route: (name) =>
    `Route «${name}» not found. Use the short name shown on the vehicle, with its type prefix: "Т30" or "T30" (tram/trolleybus), "А1" or "A01" (bus), "Н2" (night bus). A bare number is read as an internal route ID.`,
  vehicle: (id) =>
    `Vehicle «${id}» is not reporting a position right now — it may have finished its trip. Get current vehicle IDs from get_route_realtime or get_nearby_vehicles.`,
};

function formatToolResult(toolName, actionResult, notFoundHint) {
  const { statusCode, body } = actionResult;

  if (statusCode === 404 && notFoundHint) {
    return toolError(notFoundHint);
  }

  if (statusCode >= 400) {
    const errorText =
      typeof body === "string"
        ? body
        : (typeof body === "object" && body?.error)
          ? body.error
          : `${toolName} failed with status ${statusCode}`;
    return toolError(errorText);
  }

  const structured = buildUiPayload(toolName, body);
  return {
    structuredContent: structured,
    content: [
      {
        type: "text",
        text: buildTextSummary(toolName, structured),
      },
    ],
  };
}

const MCP_RESOURCES = {
  about: `# Lviv Timetable MCP

Read-only access to **public** timetable and live vehicle data for municipal transit in **Lviv, Ukraine** (lad.lviv.ua ecosystem). No authentication required.

${TRANSIT_ASSISTANT_GUIDANCE}
## How to work with this server

- Prefer **tools** for live structured data.
- Use **prompts** (\`transit-map-view\`, \`transit-arrival-list\`, \`transit-hybrid-view\`) for ready-made rendering workflows.
- Use **resources** (\`timetable://about\`, \`timetable://reference/tools\`, \`timetable://reference/prompts\`) for reference without calling tools.
- Use **resource templates** (\`timetable://stop/{code}\`, \`timetable://route/{name}\`) to read static stop or route info directly.
`,

  tools: `## Tools reference

| Tool | Purpose |
|------|---------|
| \`search_stops\` | Stops matching a name (Ukrainian or English), with IDs, coordinates and serving routes. |
| \`get_stops_around_location\` | Stops near lat/lon (ID, name, coordinates, distance, serving routes). |
| \`get_stop_realtime\` | Live arrivals at a stop: route, destination, minutes to arrival, vehicle positions. |
| \`find_routes_between\` | Direct routes from one stop to another: where to board and get off, destination, stop count. |
| \`get_route_static\` | Route metadata, stop lists for both directions, first-stop timetable; polylines on request. |
| \`get_route_realtime\` | Live vehicles on a route with destination and next stop. |
| \`get_nearby_vehicles\` | Live vehicles near a point, nearest first, optionally filtered by route. |
| \`get_vehicle_info\` | One vehicle by ID: position, route, destination, plate, upcoming stops with names. |

All tools are **read-only** and safe to retry.
`,

  prompts: `## Prompts reference

Prompts are reusable instruction templates. Pass the listed **arguments** when invoking a prompt.

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
      description: "Catalog of prompt templates and their arguments.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: MCP_RESOURCES.prompts }],
    }),
  );

  // Resource templates: stop and route static data with URI-based completions
  server.registerResource(
    "stop-template",
    new ResourceTemplate("timetable://stop/{code}", {
      list: undefined,
    }),
    {
      title: "Stop static info",
      description: "Static info for a stop by numeric code (name, routes served). Use timetable://stop/707 for stop 707.",
      mimeType: "application/json",
    },
    async (uri, { code }) => {
      const result = await runAction(getSingleStopAction, {
        stopCode: parseInt(String(code), 10),
        query: { skipTimetableData: "true" },
      });
      if (result.statusCode >= 400) {
        return {
          contents: [{ uri: uri.href, text: `Stop ${code} not found`, mimeType: "text/plain" }],
        };
      }
      const b = result.body ?? {};
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            code: b.code,
            name: b.name ?? null,
            lat: normalizeCoordinate(b.latitude),
            lng: normalizeCoordinate(b.longitude),
            routes: (Array.isArray(b.transfers) ? b.transfers : []).map((t) => t.route).filter(Boolean),
          }),
          mimeType: "application/json",
        }],
      };
    },
  );

  server.registerResource(
    "route-template",
    new ResourceTemplate("timetable://route/{name}", {
      list: undefined,
    }),
    {
      title: "Route static info",
      description: "Static metadata for a route by short name (e.g. timetable://route/T30). Returns stop counts and color.",
      mimeType: "application/json",
    },
    async (uri, { name }) => {
      const result = await runAction(routeInfoStaticAction, {
        params: { name: String(name) },
      });
      if (result.statusCode >= 400) {
        return {
          contents: [{ uri: uri.href, text: `Route ${name} not found`, mimeType: "text/plain" }],
        };
      }
      const b = result.body ?? {};
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            name: b.route_short_name ?? null,
            long_name: b.route_long_name ?? null,
            color: b.color ?? null,
            type: b.type ?? null,
            stops_outbound: (Array.isArray(b.stops?.[0]) ? b.stops[0] : []).length,
            stops_inbound: (Array.isArray(b.stops?.[1]) ? b.stops[1] : []).length,
          }),
          mimeType: "application/json",
        }],
      };
    },
  );
}

const zLatitude = (what) =>
  z.number().min(-90).max(90).describe(`Decimal latitude of the ${what}, WGS84 (e.g. 49.842 for central Lviv).`);
const zLongitude = (what) =>
  z.number().min(-180).max(180).describe(`Decimal longitude of the ${what}, WGS84 (e.g. 24.031 for central Lviv).`);

const countToolCall = (tool) => Sentry.metrics.count("mcp.tool_call", 1, { attributes: { tool } });

/** Runs `fetch` unless a live cache entry exists; only successful results are cached. */
async function cachedTool(toolName, cacheArgs, fetch) {
  const cached = getCached(toolName, cacheArgs);
  if (cached) return cached;
  const result = await fetch();
  if (!result.isError) setCached(toolName, cacheArgs, result);
  return result;
}

const ok = (toolName, body) => formatToolResult(toolName, { statusCode: 200, body });

/** RFC 1123 from the REST action → ISO 8601, like every other timestamp in these tools. */
const toIsoOrNull = (value) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const toStopObj = (s) => ({
  id: String(s.code),
  name: s.name ?? null,
  lat: normalizeCoordinate(s.lat),
  lng: normalizeCoordinate(s.lng),
});

function registerTools(server) {
  server.registerTool(
    "get_stop_realtime",
    {
      title: "Get Stop Realtime",
      description:
        "Returns live arrivals at a stop: route, destination, vehicle type, minutes until arrival, and each vehicle's position. " +
        "Use this as the **default tool** when the user asks about arrivals, departures, or the next bus/tram at a specific stop. " +
        "Requires a numeric stop ID (shown on stop signage); use `search_stops` when you have a stop name, or `get_stops_around_location` when you have coordinates.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: { stop_id: zStopId() },
      outputSchema: OUTPUT_SCHEMAS.get_stop_realtime,
    },
    async ({ stop_id }) => {
      countToolCall("get_stop_realtime");
      const stopCode = normalizeStopCode(stop_id);
      return cachedTool("get_stop_realtime", { stop_id: stopCode }, async () => {
        const actionResult = await runAction(getSingleStopAction, {
          stopCode,
          query: { skipTimetableData: "false" },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_stop_realtime", actionResult);
        }

        const body = actionResult.body ?? {};
        return ok("get_stop_realtime", {
          stop: toStopObj({ code: body.code, name: body.name, lat: body.latitude, lng: body.longitude }),
          arrivals: sortedArrivals(
            Array.isArray(body.timetable) ? body.timetable.map((item) => normalizeRealtimeArrival(item)) : [],
          ),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "search_stops",
    {
      title: "Search Stops",
      description:
        "Finds stops by name (Ukrainian or English transliteration, case-insensitive, partial match) and returns each stop's numeric ID, coordinates, and the routes serving it. " +
        "Use this as the **first step** when the user names a stop or landmark stop (e.g. \"Опера\", \"Rynok\", \"Головний вокзал\") and you need a stop ID for `get_stop_realtime` or `find_routes_between`. " +
        "One name usually covers both sides of the street under different IDs; each is returned, and the `routes` list tells them apart. " +
        "Use `get_stops_around_location` instead when you have coordinates rather than a name.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        query: z.string().trim().min(2).describe("Stop name or part of it, e.g. \"Ринок\", \"opera\", \"Стрийська\"."),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum stops to return (1–25, default 10)."),
      },
      outputSchema: OUTPUT_SCHEMAS.search_stops,
    },
    async ({ query, limit }) => {
      countToolCall("search_stops");
      const max = limit ?? 10;
      return cachedTool("search_stops", { query: query.toLowerCase(), limit: max }, async () =>
        ok("search_stops", {
          query,
          stops: searchStops(query, max).map((s) => ({
            ...toStopObj(s),
            eng_name: s.eng_name,
            routes: s.routes,
          })),
          updated_at: new Date().toISOString(),
        }),
      );
    },
  );

  server.registerTool(
    "find_routes_between",
    {
      title: "Find Routes Between Stops",
      description:
        "Lists the direct routes (no transfer) from one place to another: which stop to board, where to get off, the direction's destination, stops in between, and the walk at each end — best first, walking counted. " +
        "Use when the user asks how to get from A to B, or which bus/tram goes from one place to another. " +
        "Each end covers every stop within a 300 m walk of the one given, since a line's two directions often stop on opposite sides of a street under different names; `board_stop` says where to actually wait. " +
        "An empty `options` list means no direct route: a transfer is needed. " +
        "Requires numeric stop IDs; get them with `search_stops` or `get_stops_around_location` first. Follow up with `get_stop_realtime` on `board_stop` for live departures.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        from_stop_id: zStopId().describe("Stop ID where the trip starts."),
        to_stop_id: zStopId().describe("Stop ID where the trip ends."),
      },
      outputSchema: OUTPUT_SCHEMAS.find_routes_between,
    },
    async ({ from_stop_id, to_stop_id }) => {
      countToolCall("find_routes_between");
      const from = normalizeStopCode(from_stop_id);
      const to = normalizeStopCode(to_stop_id);
      return cachedTool("find_routes_between", { from, to }, async () => {
        const result = findRoutesBetween(from, to);
        if (result.missing != null) {
          return toolError(`Stop ${result.missing} not found. Look up stop IDs with search_stops or get_stops_around_location.`);
        }
        const endpoint = (e) => ({ id: String(e.code), name: e.name ?? null, stop_ids: e.codes.map(String) });
        return ok("find_routes_between", {
          from: endpoint(result.from),
          to: endpoint(result.to),
          options: result.options.map((o) => ({
            route: o.route,
            vehicle_type: o.vehicle_type,
            direction: o.direction,
            destination: o.destination,
            board_stop: toStopObj(o.board_stop),
            alight_stop: toStopObj(o.alight_stop),
            stops_count: o.stops_count,
            walk_to_board_meters: o.walk_to_board_meters,
            walk_from_alight_meters: o.walk_from_alight_meters,
          })),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_route_static",
    {
      title: "Get Route Static",
      description:
        "Returns static route data: name, long name, vehicle type, colour, the ordered stop list for both directions, and the timetable of departures from the first stop (workday and weekend). " +
        "Use when the user asks which stops a route serves, where it goes, or its scheduled departure times. " +
        "Set `include_shapes` only when you will draw the route on a map — the polylines are large and carry nothing a text answer needs. " +
        "Do NOT use this for live vehicle positions — use `get_route_realtime` instead. " +
        "Requires a route short name (e.g. \"T30\", \"32A\") or numeric external ID.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
        include_shapes: z
          .boolean()
          .optional()
          .describe("Include route polylines ([lat, lng] points per direction) for map drawing. Default false."),
      },
      outputSchema: OUTPUT_SCHEMAS.get_route_static,
    },
    async ({ route_name, include_shapes }) => {
      countToolCall("get_route_static");
      const withShapes = include_shapes === true;
      return cachedTool("get_route_static", { route_name, withShapes }, async () => {
        const actionResult = await runAction(routeInfoStaticAction, {
          params: { name: route_name },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_route_static", actionResult, NOT_FOUND_HINTS.route(route_name));
        }

        const body = actionResult.body ?? {};
        return ok("get_route_static", {
          route: {
            name: body.route_short_name ? formatRouteName(body.route_short_name) : null,
            long_name: body.route_long_name ?? null,
            color: body.color ?? null,
            type: body.type ?? null,
          },
          stops: (Array.isArray(body.stops) ? body.stops : []).map((dirStops) =>
            (Array.isArray(dirStops) ? dirStops : []).map((s) => ({
              ...toStopObj({ code: s.code, name: s.name, lat: s.loc?.[0], lng: s.loc?.[1] }),
              departures: Array.isArray(s.departures) ? s.departures : [],
              schedule: s.schedule
                ? {
                    workday: Array.isArray(s.schedule.workday) ? s.schedule.workday : [],
                    weekend: Array.isArray(s.schedule.weekend) ? s.schedule.weekend : [],
                  }
                : undefined,
            })),
          ),
          // shapes_by_direction() assigns by direction index, so a route with
          // only one direction leaves a hole. Holes are `undefined`, which fails
          // the output schema and turns the whole call into an McpError.
          ...(withShapes
            ? {
                shapes: (Array.isArray(body.shapes) ? body.shapes : []).filter(
                  (shape) => Array.isArray(shape) && shape.length > 0,
                ),
              }
            : {}),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_route_realtime",
    {
      title: "Get Route Realtime",
      description:
        "Returns every vehicle currently running on a route: position, the destination it is heading to, and its next stop with estimated arrival. " +
        "Use when the user asks \"where is my tram/bus right now?\", how many vehicles are running, or how far the next one is. " +
        "Prefer `get_stop_realtime` when the user is at a stop and wants arrival times there. " +
        "Requires a route short name (e.g. \"T30\", \"32A\") or numeric external ID.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: { route_name: zRouteName() },
      outputSchema: OUTPUT_SCHEMAS.get_route_realtime,
    },
    async ({ route_name }) => {
      countToolCall("get_route_realtime");
      return cachedTool("get_route_realtime", { route_name }, async () => {
        const actionResult = await runAction(routeDynamicInfoAction, {
          params: { name: route_name },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_route_realtime", actionResult, NOT_FOUND_HINTS.route(route_name));
        }

        const route = resolveRoute(route_name);
        const destinations = route?.destinations ?? [null, null];
        const rawVehicles = Array.isArray(actionResult.body) ? actionResult.body : [];
        const nextStops = await nextStopsForVehicles(rawVehicles.map((v) => v.id).filter(Boolean));

        return ok("get_route_realtime", {
          route_name: route?.name ?? route_name,
          destinations,
          vehicles: rawVehicles.map((v, index) => {
            const direction = typeof v.direction === "number" ? v.direction : null;
            const next = nextStops[String(v.id)];
            return {
              id: String(v.id ?? `vehicle-${index + 1}`),
              direction,
              destination: direction != null ? destinations[direction] ?? null : null,
              next_stop: next ? { id: String(next.code), name: next.name ?? null, arrival: next.arrival } : null,
              lat: normalizeCoordinate(v.location?.[0]),
              lng: normalizeCoordinate(v.location?.[1]),
              bearing: normalizeBearing(v.bearing),
              lowfloor: typeof v.lowfloor === "boolean" ? v.lowfloor : null,
            };
          }),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_stops_around_location",
    {
      title: "Get Stops Around Location",
      description:
        "Finds stops near a geographic point, returning each stop's numeric ID, name, coordinates, walking distance, and the routes serving it. " +
        "Use this as the **first step** when the user gives an address or coordinates and you need stop IDs for `get_stop_realtime` or `find_routes_between`. " +
        "Use `search_stops` instead when the user gives a stop name. " +
        "Default radius is 1 000 m; narrow it (e.g. 300 m) for dense urban areas or widen it (up to 3 000 m) for rural locations.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: zLatitude("search centre"),
        longitude: zLongitude("search centre"),
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
      outputSchema: OUTPUT_SCHEMAS.get_stops_around_location,
    },
    async ({ latitude, longitude, radius_meters }) => {
      countToolCall("get_stops_around_location");
      const cacheArgs = { latitude: normalizeCoordinate(latitude), longitude: normalizeCoordinate(longitude), radius_meters };
      return cachedTool("get_stops_around_location", cacheArgs, async () => {
        const query = { latitude: String(latitude), longitude: String(longitude) };
        if (radius_meters != null) query.radius = String(radius_meters);

        const actionResult = await runAction(getClosestStopsAction, { query });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_stops_around_location", actionResult);
        }

        const rows = Array.isArray(actionResult.body) ? actionResult.body : [];
        return ok("get_stops_around_location", {
          center_lat: normalizeCoordinate(latitude),
          center_lng: normalizeCoordinate(longitude),
          radius_meters: radius_meters ?? 1000,
          stops: rows.map((s) => ({
            ...toStopObj({ code: s.code, name: s.name, lat: s.latitude, lng: s.longitude }),
            routes: Array.isArray(s.routes) ? s.routes : [],
            distance_meters: Number.isFinite(s.distance_meters) ? s.distance_meters : null,
          })),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_nearby_vehicles",
    {
      title: "Get Nearby Vehicles",
      description:
        "Returns live vehicles near a point, nearest first, each with its route, destination, and distance. " +
        "Use when the user asks \"what transport is near me right now?\" or wants a live map around a location. " +
        "Narrow with `route` when the user cares about one line; prefer `get_route_realtime` for a whole route and `get_stop_realtime` for arrival times at a stop. " +
        "Requires decimal latitude and longitude (WGS84).",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        latitude: zLatitude("centre point"),
        longitude: zLongitude("centre point"),
        radius_meters: z
          .number()
          .int()
          .min(100)
          .max(1000)
          .optional()
          .describe("Search radius in metres (100–1000, default 500)."),
        route: z
          .string()
          .min(1)
          .optional()
          .describe("Only vehicles on this route, by short name (e.g. \"Т30\", \"А1\"). Omit for all routes."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum vehicles to return, nearest first (1–50, default 15). `total` reports how many were in range."),
      },
      outputSchema: OUTPUT_SCHEMAS.get_nearby_vehicles,
    },
    async ({ latitude, longitude, radius_meters, route, limit }) => {
      countToolCall("get_nearby_vehicles");
      const radius = radius_meters ?? 500;
      const max = limit ?? 15;
      const cacheArgs = {
        latitude: normalizeCoordinate(latitude),
        longitude: normalizeCoordinate(longitude),
        radius,
        route: route ?? null,
        max,
      };
      return cachedTool("get_nearby_vehicles", cacheArgs, async () => {
        const actionResult = await runAction(closestTransportAction, {
          query: { latitude: String(latitude), longitude: String(longitude) },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_nearby_vehicles", actionResult);
        }

        const wantedRoute = route ? resolveRoute(route)?.name ?? route : null;
        const inRange = (Array.isArray(actionResult.body) ? actionResult.body : [])
          .map((v) => {
            const lat = normalizeCoordinate(Array.isArray(v.location) ? v.location[0] : v.lat);
            const lng = normalizeCoordinate(Array.isArray(v.location) ? v.location[1] : v.lng);
            const distance = lat != null && lng != null ? Math.round(distanceMeters(latitude, longitude, lat, lng)) : null;
            return { v, lat, lng, distance };
          })
          .filter(({ distance }) => distance == null || distance <= radius)
          .filter(({ v }) => !wantedRoute || v.route === wantedRoute)
          .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

        const shown = inRange.slice(0, max);
        const destinations = destinationsFor(
          shown.map(({ v }) => ({ routeId: v.routeId, direction: v.direction })),
        );

        return ok("get_nearby_vehicles", {
          center_lat: normalizeCoordinate(latitude),
          center_lng: normalizeCoordinate(longitude),
          radius_meters: radius,
          total: inRange.length,
          vehicles: shown.map(({ v, lat, lng, distance }) => {
            const direction = typeof v.direction === "number" ? v.direction : null;
            return {
              id: v.id != null ? String(v.id) : null,
              route: v.route ?? null,
              vehicle_type: v.vehicle_type ?? null,
              direction,
              destination: destinations[`${v.routeId}:${direction}`] ?? null,
              lat,
              lng,
              bearing: normalizeBearing(v.bearing),
              lowfloor: typeof v.lowfloor === "boolean" ? v.lowfloor : null,
              distance_meters: distance,
            };
          }),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_vehicle_info",
    {
      title: "Get Vehicle Info",
      description:
        "Returns details for one vehicle by ID: position, route, destination, license plate, and its upcoming stops with names and estimated arrival times. " +
        "Use when the user wants to follow a particular vehicle, e.g. \"where does this tram go next?\" or \"when will it reach X?\". " +
        "Vehicle IDs come from `get_route_realtime`, `get_nearby_vehicles`, or `get_stop_realtime` results. " +
        "Do NOT use this to get all vehicles on a route — use `get_route_realtime` instead.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        vehicle_id: z
          .string()
          .min(1)
          .describe("Vehicle ID as returned by get_route_realtime, get_nearby_vehicles, or get_stop_realtime."),
      },
      outputSchema: OUTPUT_SCHEMAS.get_vehicle_info,
    },
    async ({ vehicle_id }) => {
      countToolCall("get_vehicle_info");
      return cachedTool("get_vehicle_info", { vehicle_id }, async () => {
        const actionResult = await runAction(vehicleInfoAction, {
          params: { vehicleId: vehicle_id },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_vehicle_info", actionResult, NOT_FOUND_HINTS.vehicle(vehicle_id));
        }

        const body = actionResult.body ?? {};
        const direction = typeof body.direction === "number" ? body.direction : null;
        // `route` is the short name ("Т30"); fall back to the opaque GTFS routeId
        // only when the route is missing from the local DB. Both are accepted as
        // the `route_name` input of get_route_static / get_route_realtime.
        const routeName = body.route ?? body.routeId ?? null;
        const destination =
          direction != null ? destinationsFor([{ routeId: body.routeId, direction }])[`${body.routeId}:${direction}`] ?? null : null;

        return ok("get_vehicle_info", {
          vehicle_id: String(body.vehicleId ?? vehicle_id),
          route: routeName,
          license_plate: body.licensePlate || null,
          lat: normalizeCoordinate(body.location?.[0]),
          lng: normalizeCoordinate(body.location?.[1]),
          bearing: normalizeBearing(body.bearing),
          direction,
          destination,
          // The feed keeps stops for a while after the vehicle has left them.
          upcoming_stops: (Array.isArray(body.arrivals) ? body.arrivals : [])
            .map((a) => ({
              id: String(a.code),
              name: a.name ?? null,
              arrival: toIsoOrNull(a.arrival),
              departure: toIsoOrNull(a.departure),
            }))
            .filter((s) => {
              const ms = Date.parse(s.departure ?? s.arrival ?? "");
              return !Number.isFinite(ms) || ms >= Date.now() - PASSED_GRACE_MS;
            }),
          updated_at: new Date().toISOString(),
        });
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
              "",
              "Output format:",
              "- Return strict JSON only.",
              "- Always output `ui_blocks` with first block `map`, second block `arrival_list`.",
              "- Ensure route labels and ETA values are consistent across both blocks.",
              "- Any arrival without an ETA (`arrival_minutes: null`) must be shown as \"no ETA\", not dropped.",
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
      capabilities: {},
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  server.server.setRequestHandler(PingRequestSchema, () => ({}));

  registerTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}

/**
 * Some clients serialise an absent `params` as an explicit null. The JSON-RPC
 * schema in the SDK only accepts an object there, so the whole request is
 * rejected with "Parse error: Invalid JSON-RPC message" before it ever reaches
 * a handler. Dropping the null is equivalent to the client having omitted the
 * key, so accept it instead of failing the request.
 */
function dropNullParams(body) {
  if (Array.isArray(body)) {
    return body.map(dropNullParams);
  }

  if (body === null || typeof body !== "object" || body.params !== null) {
    return body;
  }

  const { params, ...rest } = body;
  return rest;
}

export async function handleMcpPostRequest(req, res) {
  const server = createTimetableMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, dropNullParams(req.body));
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
