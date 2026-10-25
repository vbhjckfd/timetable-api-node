import * as metrics from "../utils/metrics.ts";
import * as z from "zod/v4";
import pkg from "../package.json" with { type: "json" };
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpError, PingRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";

import getSingleStopAction from "../actions/getSingleStopAction.ts";
import getClosestStopsAction from "../actions/getClosestStopsAction.ts";
import closestTransportAction from "../actions/closestTransportAction.ts";
import vehicleInfoAction from "../actions/vehicleInfoAction.ts";
import routeInfoStaticAction from "../actions/routeStaticInfoAction.ts";
import routeDynamicInfoAction from "../actions/routeDynamicInfoAction.ts";
import {
  destinationsFor,
  etasForVehicles,
  findRoutesBetween,
  listRouteNames,
  PASSED_GRACE_MS,
  POINT_WALK_RADIUS_METERS,
  resolveRoute,
  searchStops,
} from "../services/transitLookupService.ts";
import type { RoutesBetween, StopEta, StopSummary, TransferOption, TripEnd, TripLeg } from "../services/transitLookupService.ts";
import { parseTripTime, scheduledHeadway, scheduleTrip } from "../services/tripScheduleService.ts";
import { activeDisruptions, servedFilter } from "../services/disruptionService.ts";
import type { DisruptionFilter } from "../services/disruptionService.ts";
import { distanceMeters, formatRouteName } from "../utils/appHelpers.ts";
import type { ScheduleByDayType } from "../utils/stopScheduleByDayType.ts";

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
- User asks how to get from A to B, how long it takes, or when to leave → \`find_routes_between\` with stop IDs or coordinates for each end (direct routes, or one interchange). Each option already carries live next departures and a timetable estimate; pass \`depart_at\` or \`arrive_by\` for another time
- User asks "where is route X right now", how many vehicles run on it, or how often it runs → \`get_route_realtime\` (\`headways\` per direction)
- User asks which stops a route serves, where it goes, or its timetable → \`get_route_static\` (\`include_shapes: true\` only for drawing a map)
- User asks "what vehicles are near me" → \`get_nearby_vehicles\` (filter with \`route\` when relevant)
- User needs step-free access (wheelchair, pram) → pass \`lowfloor_only: true\` to \`get_stop_realtime\` or \`get_nearby_vehicles\`
- User wants to follow one vehicle by ID → \`get_vehicle_info\`
- User asks about closures, road works, detours or why a route is not running → \`get_disruptions\` (optionally filtered by \`route\` or \`stop_id\`)

## Input conventions

- Stop IDs are **numeric codes** printed on physical stop signage (e.g. 707). Accept both integer and digits-only string.
- Route names are **short names** as shown on vehicles and stops (e.g. "Т30", "А1"); Latin letters ("T30", "A01") work too. Numeric external IDs are also accepted, so a bare number is not a route name.
- Never guess a stop ID from a place name — resolve it with \`search_stops\` or \`get_stops_around_location\` first. \`find_routes_between\` also takes coordinates directly.
- Times (\`depart_at\`, \`arrive_by\`, \`schedule\`) are Lviv local time, "HH:MM".
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

- Live positions and ETAs come from upstream GTFS-RT feeds; occasional gaps or stale positions are expected. An arrival with \`scheduled: true\` is a timetable entry, not a tracked vehicle.
- \`find_routes_between\` \`schedule\` times are estimates from per-stop timetables: ride times are inferred, not read off one trip, and public holidays run as their weekday.
- \`get_route_static\` departure times (\`departures\` and \`schedule.workday\`/\`saturday\`/\`sunday\`) are only populated for the first stop of each direction. Saturday and Sunday timetables can differ; \`schedule.weekend\` merges both days and is kept only for backward compatibility.
- \`direction\` is the index into \`get_route_static\`'s \`stops\` array (0 = outbound, 1 = return); \`destination\` is the name of that direction's last stop.
- Detours, suspended routes and moved stops are not in the GTFS feed. \`get_stop_realtime\`, \`get_route_static\`, \`get_route_realtime\` and \`find_routes_between\` add a \`disruptions\` array when an announced one touches their routes or stops; always tell the user about it, since stop lists and timetables do not reflect it.
- \`find_routes_between\` allows at most one interchange, made within a walkable stop cluster (≤ 300 m). Suspended routes and stops a detour skips are left out. \`walk_meters\` means the two stops are a short walk apart and no ride is needed; otherwise empty \`options\` and \`transfer_options\` mean the trip needs two or more transfers.
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
  /** null when unknown: a timetable entry has no vehicle to tell. */
  lowfloor: z.boolean().nullable(),
  /** true for a published-timetable departure shown because no vehicle is predicted yet. */
  scheduled: z.boolean(),
});
const zNextStop = z.object({ id: z.string(), name: z.string().nullable(), arrival: z.string() }).nullable();
const zCenter = z.tuple([zCoord, zCoord]);
const zDisruptionRoute = z.object({ name: z.string(), id: z.string() });
const zDisruption = z.object({
  id: z.string(),
  kind: z.enum(["suspended", "detour", "stop_moved", "stop_closed"]),
  reason: z.string(),
  since: z.string(),
  until: z.string().nullable(),
  until_text: z.string().nullable(),
  routes: z.array(zDisruptionRoute),
  stops: z.array(z.number().int()),
  alternatives: z.array(zDisruptionRoute),
  detour: z.object({ via: z.array(z.string()), skipped_stops: z.array(z.number().int()) }).nullable(),
  note: z.string().nullable(),
  source: z.string().nullable(),
  url: z.string().nullable(),
});
/** Only present when an announced disruption touches the result, so most answers stay as they were. */
const zDisruptions = z.array(zDisruption).optional();
const zNextDeparture = z.object({
  arrival_minutes: z.number().int().nullable(),
  scheduled: z.boolean(),
  vehicle_id: z.string().nullable(),
  lowfloor: z.boolean().nullable(),
});
const zTripSchedule = z
  .object({
    leave_at: z.string(),
    arrive_at: z.string(),
    total_minutes: z.number().int(),
    legs: z.array(z.object({ board_at: z.string(), alight_at: z.string() })),
  })
  .nullable();
/** What both kinds of trip option carry on top of their legs. */
const zTripTiming = {
  /** Timetable estimate in Lviv local time; null when the day's service does not cover the trip. */
  schedule: zTripSchedule,
  /** Live departures of the first leg from its boarding stop; only when planning for now. */
  next_departures: z.array(zNextDeparture).optional(),
};
const zTripEndpoint = z.object({
  id: z.string(),
  name: z.string().nullable(),
  stop_ids: z.array(z.string()),
  /** Set when the end was given as coordinates; `id` is then the stop nearest to it. */
  point: z.object({ lat: z.number(), lng: z.number() }).optional(),
});
const zTripLeg = z.object({
  route: z.string(),
  vehicle_type: z.string(),
  direction: z.number().int(),
  destination: z.string().nullable(),
  board_stop: zStopObj,
  alight_stop: zStopObj,
  stops_count: z.number().int(),
});

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

const transitResult = <D extends z.ZodType, B extends z.ZodType = typeof zMapBlock>(
  data: D,
  uiBlock: B = zMapBlock as unknown as B,
) =>
  z.object({
    view: z.literal("transit_realtime"),
    data,
    ui_blocks: z.array(uiBlock),
  });

const OUTPUT_SCHEMAS = {
  get_stop_realtime: transitResult(
    z.object({ stop: zStopObj, arrivals: z.array(zArrivalObj), lowfloor_only: z.boolean(), disruptions: zDisruptions, updated_at: z.string() }),
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
      schedule: z.object({
        workday: z.array(z.string()),
        saturday: z.array(z.string()),
        sunday: z.array(z.string()),
        weekend: z.array(z.string()),
      }).optional(),
    }))),
    shapes: z.array(z.array(z.array(z.number()))).optional(),
    disruptions: zDisruptions,
    updated_at: z.string(),
  })),
  get_route_realtime: transitResult(z.object({
    route_name: z.string(),
    destinations: z.array(z.string().nullable()),
    direction: z.number().int().nullable(),
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
    headways: z.array(z.object({
      direction: z.number().int(),
      destination: z.string().nullable(),
      vehicles: z.number().int(),
      /** Minutes between consecutive vehicles, front to back; null where the feed does not reach far enough back. */
      gaps_minutes: z.array(z.number().int().nullable()),
      scheduled_headway_minutes: z.number().int().nullable(),
    })),
    disruptions: zDisruptions,
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
    from: zTripEndpoint,
    to: zTripEndpoint,
    /** What the timetable estimates are for, in Lviv local "HH:MM". */
    timing: z.object({ mode: z.enum(["depart_at", "arrive_by"]), at: z.string() }),
    options: z.array(zTripLeg.extend({
      walk_to_board_meters: z.number().int(),
      walk_from_alight_meters: z.number().int(),
      ...zTripTiming,
    })),
    transfer_options: z.array(z.object({
      legs: z.array(zTripLeg),
      transfer_walk_meters: z.number().int(),
      stops_count: z.number().int(),
      walk_to_board_meters: z.number().int(),
      walk_from_alight_meters: z.number().int(),
      ...zTripTiming,
    })),
    map_stops: z.array(zStopObj.extend({ role: z.enum(["board", "transfer", "transfer_alight", "transfer_board", "alight"]) })),
    /** Only present when the two stops are a short walk apart, in which case no ride is searched. */
    walk_meters: z.number().int().optional(),
    disruptions: zDisruptions,
    updated_at: z.string(),
  })),
  get_nearby_vehicles: transitResult(z.object({
    center_lat: zCoord,
    center_lng: zCoord,
    radius_meters: z.number(),
    lowfloor_only: z.boolean(),
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
  get_disruptions: transitResult(z.object({
    route: z.string().nullable(),
    stop_id: z.string().nullable(),
    disruptions: z.array(zDisruption),
    updated_at: z.string(),
  })),
};

type ToolName = keyof typeof OUTPUT_SCHEMAS;
type ToolData<N extends ToolName> = z.infer<(typeof OUTPUT_SCHEMAS)[N]>["data"];
type TripLegOut = z.infer<typeof zTripLeg>;

// --- In-process TTL cache ---

const _toolCache = new Map<string, { value: CallToolResult; expiresAt: number }>();
const CACHE_TTL_MS: Record<ToolName, number> = {
  get_stop_realtime: 10_000,
  get_route_realtime: 10_000,
  get_nearby_vehicles: 10_000,
  get_vehicle_info: 5_000,
  get_stops_around_location: 60_000,
  get_route_static: 5 * 60_000,
  search_stops: 5 * 60_000,
  // Live departures ride along now; the route search itself is memoised longer.
  find_routes_between: 10_000,
  get_disruptions: 5 * 60_000,
};

function getCached(toolName: ToolName, args: unknown): CallToolResult | null {
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

function setCached(toolName: ToolName, args: unknown, value: CallToolResult): void {
  const ttl = CACHE_TTL_MS[toolName] ?? 10_000;
  const now = Date.now();

  if (_toolCache.size >= MAX_CACHE_ENTRIES) {
    for (const [key, entry] of _toolCache) {
      if (now > entry.expiresAt) _toolCache.delete(key);
    }
    // Everything still live: drop the least recently written keys.
    while (_toolCache.size >= MAX_CACHE_ENTRIES) {
      _toolCache.delete(_toolCache.keys().next().value!);
    }
  }

  const key = `${toolName}:${JSON.stringify(args)}`;
  // Re-insert so Map iteration order tracks write recency.
  _toolCache.delete(key);
  _toolCache.set(key, { value, expiresAt: now + ttl });
}

// --- Normalizers ---

function normalizeStopCode(stopId: unknown): number {
  const parsed = Number.parseInt(String(stopId), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid stop_id: ${stopId}`);
  }
  return parsed;
}

function normalizeCoordinate(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(5)) : null;
}

function normalizeBearing(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A timetable entry as getSingleStopAction serves it. Read defensively: the
 * fields are whatever the live or scheduled arrival carried.
 */
interface TimetableEntry {
  arrival_minutes?: unknown;
  time_left?: unknown;
  arrival_time?: unknown;
  route?: string | null;
  end_stop?: string | null;
  direction?: unknown;
  vehicle_type?: string | null;
  vehicle_id?: string | null;
  location?: unknown;
  lat?: unknown;
  lng?: unknown;
  bearing?: unknown;
  direction_id?: unknown;
  lowfloor?: unknown;
  scheduled?: unknown;
}

export function parseArrivalMinutes(entry: TimetableEntry): number | null {
  if (typeof entry.arrival_minutes === "number" && Number.isFinite(entry.arrival_minutes)) {
    return Math.max(0, Math.round(entry.arrival_minutes));
  }
  if (typeof entry.time_left === "string") {
    // getTextWaitTime renders anything under a minute as "< 1хв": that is 0,
    // not the 1 its only digit would read as.
    if (entry.time_left.trim().startsWith("<")) return 0;
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

function normalizeRealtimeArrival(entry: TimetableEntry): ToolData<"get_stop_realtime">["arrivals"][number] {
  const [rawLat, rawLng]: unknown[] = Array.isArray(entry.location)
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
    // A timetable entry always says lowfloor: false, which is a placeholder, not a fact.
    lowfloor: entry.scheduled === true ? null : typeof entry.lowfloor === "boolean" ? entry.lowfloor : null,
    scheduled: entry.scheduled === true,
  };
}

function sortedArrivals<T extends { arrival_minutes: number | null }>(arrivals: T[]): T[] {
  return [...arrivals].sort((a, b) => {
    if (a.arrival_minutes === null && b.arrival_minutes === null) return 0;
    if (a.arrival_minutes === null) return 1;
    if (b.arrival_minutes === null) return -1;
    return a.arrival_minutes - b.arrival_minutes;
  });
}

// --- Natural-language text summaries (replaces full JSON dump) ---

const plural = (count: number, word: string): string => `${count} ${word}${count !== 1 ? "s" : ""}`;
const routeList = (routes: string[] | undefined): string => (routes?.length ? `, routes ${routes.join(", ")}` : "");
/** Whole minutes from now until an ISO timestamp; null when unknown, 0 when already due. */
const minutesUntil = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.round((t - Date.now()) / 60_000));
};

type DisruptionOut = z.infer<typeof zDisruption>;

const KIND_LABEL: Record<DisruptionOut["kind"], string> = {
  suspended: "not running",
  detour: "on a detour",
  stop_moved: "stop moved",
  stop_closed: "stop closed",
};

function describeDisruption(d: DisruptionOut): string {
  const routes = d.routes.map((r) => r.name).join(", ");
  const stops = d.stops.length ? ` (stops ${d.stops.join(", ")})` : "";
  const via = d.detour?.via.length ? ` via ${d.detour.via.join(", ")}` : "";
  const until = d.until_text ?? (d.until ? `until ${d.until}` : "no end date announced");
  const instead = d.alternatives.length ? `; use ${d.alternatives.map((r) => r.name).join(", ")} instead` : "";
  const note = d.note ? ` ${d.note}` : "";
  return `${routes ? `${routes} ` : ""}${KIND_LABEL[d.kind]}${stops}${via}: ${d.reason}, since ${d.since}, ${until}${instead}.${note}`;
}

/** The text a model reads must carry the disruption too: some clients drop structuredContent. */
function disruptionSuffix(data: unknown): string {
  const list = (data as { disruptions?: DisruptionOut[] } | null)?.disruptions;
  return list?.length ? ` Announced disruptions: ${list.map(describeDisruption).join(" ")}` : "";
}

function buildTextSummary(toolName: ToolName, structured: { data: unknown }): string {
  if (toolName === "get_disruptions") {
    const data = structured.data as ToolData<"get_disruptions">;
    const scope = [data.route && `route ${data.route}`, data.stop_id && `stop ${data.stop_id}`].filter(Boolean).join(" or ");
    if (!data.disruptions.length) return `No announced disruptions${scope ? ` for ${scope}` : ""} in force today.`;
    return `${plural(data.disruptions.length, "announced disruption")}${scope ? ` for ${scope}` : ""} in force today: ${data.disruptions.map(describeDisruption).join(" ")}`;
  }
  return buildToolSummary(toolName, structured) + disruptionSuffix(structured.data);
}

function buildToolSummary(toolName: ToolName, structured: { data: unknown }): string {
  switch (toolName) {
    case "get_stop_realtime": {
      const data = structured.data as ToolData<"get_stop_realtime">;
      const stopName = data.stop?.name ?? `#${data.stop?.id}`;
      const count = data.arrivals?.length ?? 0;
      if (count === 0) return `Stop «${stopName}»: no ${data.lowfloor_only ? "low-floor " : ""}arrivals found.`;
      // Clients that only show the model `content` (not structuredContent) must
      // still see every arrival, or it reports a later trolleybus as missing.
      const list = data.arrivals.map((a) => {
        // null is an unknown ETA, not an imminent one.
        const eta = a.arrival_minutes != null ? `in ${a.arrival_minutes} min` : "no ETA";
        const tags = [a.scheduled && "scheduled, not tracked", a.lowfloor && "low-floor"].filter(Boolean);
        return `${a.route ?? "?"} → «${a.direction ?? "?"}» ${eta}${tags.length ? ` (${tags.join(", ")})` : ""}`;
      }).join("; ");
      return `Stop «${stopName}»: ${plural(count, `${data.lowfloor_only ? "low-floor " : ""}arrival`)}: ${list}.`;
    }
    case "get_route_static": {
      const data = structured.data as ToolData<"get_route_static">;
      const name = data.route?.name ?? "?";
      const longName = data.route?.long_name;
      const directions = (data.stops ?? []).map((stops, i) => {
        const label = i === 0 ? "outbound" : "inbound";
        const list = stops.map((s) => `«${s.name ?? "?"}» (${s.id})`).join(", ");
        const timetables = stops.map(stopTimetable).filter(Boolean).join(" ");
        return `${label} ${plural(stops.length, "stop")}: ${list || "none"}${timetables ? `. ${timetables}` : ""}`;
      });
      return `Route ${name}${longName ? ` (${longName})` : ""}. ${directions.join(". ")}.`;
    }
    case "get_route_realtime": {
      const data = structured.data as ToolData<"get_route_realtime">;
      const count = data.vehicles?.length ?? 0;
      const towardsLabel = data.direction != null ? ` towards «${data.destinations[data.direction] ?? "?"}»` : "";
      if (count === 0) return `Route ${data.route_name}${towardsLabel}: no active vehicles.${headwaySummary(data.headways)}`;
      const list = data.vehicles.map((v) => {
        const towards = v.destination ? ` → «${v.destination}»` : "";
        const eta = minutesUntil(v.next_stop?.arrival);
        const next = v.next_stop ? `, next stop «${v.next_stop.name ?? "?"}» (${v.next_stop.id})${eta != null ? ` in ${eta} min` : ""}` : "";
        return `${v.id}${towards}${next}${v.lowfloor ? ", low-floor" : ""}`;
      }).join("; ");
      return `Route ${data.route_name}${towardsLabel}: ${plural(count, "active vehicle")}: ${list}.${headwaySummary(data.headways)}`;
    }
    case "get_stops_around_location": {
      const data = structured.data as ToolData<"get_stops_around_location">;
      const count = data.stops?.length ?? 0;
      if (count === 0) return `No stops found within ${data.radius_meters}m.`;
      const list = data.stops.map((s) => `«${s.name}» (code ${s.id}, ${s.distance_meters ?? "?"}m${routeList(s.routes)})`).join("; ");
      return `${plural(count, "stop")} within ${data.radius_meters}m, nearest first: ${list}.`;
    }
    case "search_stops": {
      const data = structured.data as ToolData<"search_stops">;
      const count = data.stops?.length ?? 0;
      if (count === 0) return `No stops match «${data.query}».`;
      const list = data.stops.map((s) => `«${s.name}» (${s.id}${routeList(s.routes)})`).join("; ");
      return `${plural(count, "stop")} match «${data.query}»: ${list}.`;
    }
    case "find_routes_between": {
      const data = structured.data as ToolData<"find_routes_between">;
      const options = data.options ?? [];
      const transfers = data.transfer_options ?? [];
      const place = (e: (typeof data)["from"] | undefined) =>
        e?.point ? `your point (nearest stop «${e.name ?? "?"}»)` : `«${e?.name ?? "?"}»`;
      const trip = `${place(data.from)} → ${place(data.to)}`;
      const timing = (o: { schedule: z.infer<typeof zTripSchedule>; next_departures?: NextDeparture[] }) => {
        const parts = [];
        if (o.next_departures) {
          parts.push(o.next_departures.length
            ? `next ${o.next_departures.map((d) => (d.arrival_minutes != null ? `${d.arrival_minutes}` : "?")).join(", ")} min${o.next_departures.some((d) => d.scheduled) ? " (partly scheduled)" : ""}`
            : "no live departures");
        }
        parts.push(o.schedule
          ? `by timetable leave ${o.schedule.leave_at}, board ${o.schedule.legs[0].board_at}, arrive ${o.schedule.arrive_at} (${o.schedule.total_minutes} min)`
          : "no timetabled service for that time");
        return `; ${parts.join("; ")}`;
      };
      const direct = (o: (typeof options)[number]) => {
        const walk = o.walk_to_board_meters ? `, ${o.walk_to_board_meters}m walk to board` : "";
        return `${o.route} towards «${o.destination ?? "?"}» from «${o.board_stop.name}» (${o.board_stop.id}) to «${o.alight_stop.name}» (${o.alight_stop.id}), ${plural(o.stops_count, "stop")}${walk}${timing(o)}`;
      };
      const viaTransfer = (t: (typeof transfers)[number]) => {
        const [a, b] = t.legs as [TripLegOut, TripLegOut];
        const walk = t.transfer_walk_meters ? `walk ${t.transfer_walk_meters}m to «${b.board_stop.name}» (${b.board_stop.id}), ` : "";
        return `${a.route} from «${a.board_stop.name}» (${a.board_stop.id}) to «${a.alight_stop.name}», ${walk}then ${b.route} towards «${b.destination ?? "?"}» (${plural(t.stops_count, "stop")} in total)${timing(t)}`;
      };
      if (data.walk_meters != null) {
        return data.walk_meters === 0
          ? `«${data.from?.name ?? "?"}» (${data.from?.id}) is the stop you are going to: no ride needed.`
          : `«${data.to?.name ?? "?"}» (${data.to?.id}) is ${data.walk_meters}m from «${data.from?.name ?? "?"}» (${data.from?.id}): walk, no ride needed.`;
      }
      if (!options.length && !transfers.length) return `No route ${trip} with at most one transfer.`;
      const parts = [`Planned for ${data.timing.mode === "arrive_by" ? "arriving by" : "leaving at"} ${data.timing.at}, Lviv time.`];
      parts.push(options.length
        ? `${plural(options.length, "direct route")} ${trip}, best first: ${options.map(direct).join("; ")}.`
        : `No direct route ${trip}.`);
      if (transfers.length) parts.push(`${plural(transfers.length, "option")} with one transfer: ${transfers.map(viaTransfer).join("; ")}.`);
      return parts.join(" ");
    }
    case "get_nearby_vehicles": {
      const data = structured.data as ToolData<"get_nearby_vehicles">;
      const count = data.vehicles?.length ?? 0;
      if (count === 0) return `No ${data.lowfloor_only ? "low-floor " : ""}vehicles within ${data.radius_meters}m.`;
      const shown = data.total > count ? ` (nearest ${count} of ${data.total})` : "";
      const list = data.vehicles.map((v) => {
        const towards = v.destination ? ` → «${v.destination}»` : "";
        return `${v.route ?? "?"}${towards}, vehicle ${v.id ?? "?"}, ${v.distance_meters ?? "?"}m away${v.lowfloor ? ", low-floor" : ""}`;
      }).join("; ");
      return `${plural(count, `${data.lowfloor_only ? "low-floor " : ""}vehicle`)} within ${data.radius_meters}m${shown}, nearest first: ${list}.`;
    }
    case "get_vehicle_info": {
      const data = structured.data as ToolData<"get_vehicle_info">;
      const upcoming = data.upcoming_stops ?? [];
      const towards = data.destination ? ` towards «${data.destination}»` : "";
      const list = upcoming.map((s) => {
        const eta = minutesUntil(s.arrival);
        return `«${s.name ?? "?"}» (${s.id})${eta != null ? ` in ${eta} min` : ""}`;
      }).join(", ");
      return `Vehicle ${data.vehicle_id} on route ${data.route ?? "?"}${towards} (plate: ${data.license_plate ?? "unknown"}). ${plural(upcoming.length, "upcoming stop")}${list ? `: ${list}` : ""}.`;
    }
    default:
      return `${toolName as string}: data retrieved.`;
  }
}

/** Per direction: vehicles, live gaps and the timetable's headway, for the route realtime text. */
function headwaySummary(headways: ToolData<"get_route_realtime">["headways"]): string {
  const lines = headways
    .filter((h) => h.vehicles || h.scheduled_headway_minutes != null)
    .map((h) => {
      const gaps = h.gaps_minutes.length ? `, gaps ${h.gaps_minutes.map((g) => g ?? "?").join(", ")} min` : "";
      const scheduled = h.scheduled_headway_minutes != null ? `, timetable every ${h.scheduled_headway_minutes} min` : "";
      return `towards «${h.destination ?? "?"}»: ${plural(h.vehicles, "vehicle")}${gaps}${scheduled}`;
    });
  return lines.length ? ` Headways: ${lines.join("; ")}.` : "";
}

/**
 * A stop's departures as text, for clients that only show the model `content`:
 * without it a timetable question gets the stop list and nothing to answer from.
 */
function stopTimetable(s: ToolData<"get_route_static">["stops"][number][number]): string {
  const days = s.schedule
    ? ([["workday", s.schedule.workday], ["Saturday", s.schedule.saturday], ["Sunday", s.schedule.sunday]] as const)
        .filter(([, times]) => times.length)
        .map(([day, times]) => `${day} ${times.join(" ")}`)
    : [];
  if (!days.length && s.departures.length) days.push(s.departures.join(" "));
  return days.length ? `Departures from «${s.name ?? "?"}» (${s.id}): ${days.join("; ")}.` : "";
}

// --- UI payload builder ---

type MapBlock = z.infer<typeof zMapBlock>;
type UiBlock = MapBlock | z.infer<typeof zArrivalListBlock>;

const mapBlock = (center: unknown[], zoom: number, layers: MapBlock["data"]["layers"]): MapBlock => ({
  type: "map",
  data: { center: center.map((v) => normalizeCoordinate(v)) as MapBlock["data"]["center"], zoom, layers },
});

/** Map blocks carry only what `data` lacks: where to centre, how far to zoom, and which arrays to plot. */
function buildUiBlocks(toolName: ToolName, rawData: unknown): UiBlock[] {
  switch (toolName) {
    case "get_stop_realtime": {
      const data = rawData as ToolData<"get_stop_realtime">;
      return [
        mapBlock([data.stop?.lat, data.stop?.lng], 14, { stops: "data.stop", vehicles: "data.arrivals" }),
        { type: "arrival_list", data: { source: "data.arrivals" } },
      ];
    }
    case "get_route_static": {
      const data = rawData as ToolData<"get_route_static">;
      const first = data.stops?.[0]?.[0];
      return [
        mapBlock([first?.lat, first?.lng], 13, {
          stops: "data.stops",
          ...(data.shapes ? { polylines: "data.shapes" } : {}),
        }),
      ];
    }
    case "get_route_realtime": {
      const data = rawData as ToolData<"get_route_realtime">;
      const first = data.vehicles?.[0];
      return [mapBlock([first?.lat, first?.lng], 13, { vehicles: "data.vehicles" })];
    }
    case "get_stops_around_location": {
      const data = rawData as ToolData<"get_stops_around_location">;
      return [
        mapBlock([data.center_lat, data.center_lng], data.radius_meters > 1500 ? 14 : 15, { stops: "data.stops" }),
      ];
    }
    case "search_stops": {
      const data = rawData as ToolData<"search_stops">;
      const first = data.stops?.[0];
      return data.stops?.length ? [mapBlock([first!.lat, first!.lng], 14, { stops: "data.stops" })] : [];
    }
    case "find_routes_between": {
      const data = rawData as ToolData<"find_routes_between">;
      const points = (data.map_stops ?? []).filter(
        (s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null,
      );
      if (!points.length) return [];
      // Fit every stop of the trip, not just its ends: an interchange can lie
      // well off the line between them.
      const lats = points.map((p) => p.lat);
      const lngs = points.map((p) => p.lng);
      const [south, north] = [Math.min(...lats), Math.max(...lats)];
      const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
      const span = distanceMeters(south, west, north, east);
      const zoom = span < 2000 ? 14 : span < 5000 ? 13 : span < 12000 ? 12 : 11;
      return [mapBlock([(south + north) / 2, (west + east) / 2], zoom, { stops: "data.map_stops" })];
    }
    case "get_nearby_vehicles": {
      const data = rawData as ToolData<"get_nearby_vehicles">;
      return [mapBlock([data.center_lat, data.center_lng], 15, { vehicles: "data.vehicles" })];
    }
    case "get_vehicle_info": {
      const data = rawData as ToolData<"get_vehicle_info">;
      return [mapBlock([data.lat, data.lng], 15, { vehicles: "data" })];
    }
    default:
      return [];
  }
}

function buildUiPayload(toolName: ToolName, data: unknown) {
  return {
    view: "transit_realtime" as const,
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

/** The slice of an Express response the REST actions use, recorded instead of sent. */
function createMockResponse() {
  const headers: Record<string, unknown> = {};
  return {
    statusCode: 200,
    headers,
    body: undefined as unknown,
    set(name: string, value: unknown) {
      headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    sendStatus(code: number) {
      this.statusCode = code;
      this.body = undefined;
      return this;
    },
  };
}

// Actions type their own params; any here so each can be passed as is.
type Action = (req: Request<any>, res: Response, next: NextFunction) => unknown;

interface ActionResult<B> {
  statusCode: number;
  headers: Record<string, unknown>;
  /** The JSON an action answered with. Read defensively, so every field is optional. */
  body: B | undefined;
}

async function runAction<B = unknown>(
  action: Action,
  reqOverrides: { params?: Record<string, string>; query?: Record<string, string>; stopCode?: number } = {},
): Promise<ActionResult<B>> {
  let nextError: unknown;
  const req = {
    params: {},
    query: {},
    ...reqOverrides,
  };
  const res = createMockResponse();
  const next = (error?: unknown) => {
    if (error) {
      nextError = error;
    }
  };

  await action(req as unknown as Request, res as unknown as Response, next);

  if (nextError) {
    throw nextError;
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body as B | undefined,
  };
}

const toolError = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/**
 * A bare 404 tells the model nothing it can act on. These say what to try
 * next; any other failure keeps the action's own message.
 */
const NOT_FOUND_HINTS = {
  route: (name: string) =>
    `Route «${name}» not found. Use the short name shown on the vehicle, with its type prefix: "Т30" or "T30" (tram/trolleybus), "А1" or "A01" (bus), "Н2" (night bus). A bare number is read as an internal route ID.`,
  stop: (code: number) =>
    `Stop ${code} not found. Stop IDs are the numeric codes on stop signage; look them up with search_stops (by name) or get_stops_around_location (by coordinates).`,
  vehicle: (id: string) =>
    `Vehicle «${id}» is not reporting a position right now — it may have finished its trip. Get current vehicle IDs from get_route_realtime or get_nearby_vehicles.`,
};

function formatToolResult(
  toolName: ToolName,
  actionResult: { statusCode: number; body?: unknown },
  notFoundHint?: string,
): CallToolResult {
  const { statusCode, body } = actionResult;

  if (statusCode === 404 && notFoundHint) {
    return toolError(notFoundHint);
  }

  if (statusCode >= 400) {
    const errorText =
      typeof body === "string"
        ? body
        : (typeof body === "object" && (body as { error?: string } | null)?.error)
          ? (body as { error: string }).error
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
- Use **prompts** (\`plan-trip\`, \`route-status\`, \`transit-map-view\`, \`transit-arrival-list\`, \`transit-hybrid-view\`) for ready-made workflows.
- Use **resources** (\`timetable://about\`, \`timetable://reference/tools\`, \`timetable://reference/prompts\`) for reference without calling tools.
- Use **resource templates** (\`timetable://stop/{code}\`, \`timetable://route/{name}\`) to read static stop or route info directly.
`,

  tools: `## Tools reference

| Tool | Purpose |
|------|---------|
| \`search_stops\` | Stops matching a name (Ukrainian or English), with IDs, coordinates and serving routes. |
| \`get_stops_around_location\` | Stops near lat/lon (ID, name, coordinates, distance, serving routes). |
| \`get_stop_realtime\` | Live arrivals at a stop: route, destination, minutes to arrival, vehicle positions; \`lowfloor_only\` for step-free vehicles. |
| \`find_routes_between\` | Routes between two stops or points, direct or with one interchange: where to board, transfer and get off, live next departures, and a timetable estimate of when to leave and arrive (\`depart_at\` / \`arrive_by\`). |
| \`get_route_static\` | Route metadata, stop lists for both directions, first-stop timetable; polylines on request. |
| \`get_route_realtime\` | Live vehicles on a route with destination and next stop, optionally one direction; live gaps and timetable headway per direction. |
| \`get_nearby_vehicles\` | Live vehicles near a point, nearest first, optionally filtered by route or to low-floor ones. |
| \`get_vehicle_info\` | One vehicle by ID: position, route, destination, plate, upcoming stops with names. |
| \`get_disruptions\` | Announced closures, detours and moved stops in force today, optionally for one route or stop. |

All tools are **read-only** and safe to retry.
`,

  prompts: `## Prompts reference

Prompts are reusable instruction templates. Pass the listed **arguments** when invoking a prompt.

| Prompt | Arguments | Use case |
|--------|-----------|----------|
| \`transit-map-view\` | \`stop_id\` | Map-first rendering for live vehicles near a stop. |
| \`transit-arrival-list\` | \`stop_id\` | Arrival list sorted by ETA, grouped by route when needed. |
| \`transit-hybrid-view\` | \`stop_id\` | Map (top) + arrival list (bottom) with ETA consistency checks. |
| \`plan-trip\` | \`from\`, \`to\`, \`arrive_by\`? | Routes between two named places (direct or one transfer), with live departures and when to leave. |
| \`route-status\` | \`route_name\` | Where a route's vehicles are right now, how many run each way and how far apart. |
`,
};

/** JSON-RPC code MCP assigns to "resource not found". */
const RESOURCE_NOT_FOUND = -32002;

const resourceNotFound = (uri: URL, what: string) =>
  new McpError(RESOURCE_NOT_FOUND, `${what} not found`, { uri: uri.href });

/** Latin look-alikes riders type for the Cyrillic route prefixes. */
const LATIN_TO_CYRILLIC: Record<string, string> = { A: "А", T: "Т", H: "Н" };

const foldRouteInput = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[ATH]/g, (c) => LATIN_TO_CYRILLIC[c]);

/**
 * Route names starting with what was typed, Latin or Cyrillic prefix alike,
 * with or without the leading zero ("a1" → "А01", "т3" → "Т30"). Capped at
 * the 100 values a completion result may carry.
 */
export function completeRouteName(value: string): string[] {
  const typed = foldRouteInput(value);
  const unpadded = (name: string) => name.replace(/^(\D+)0+(?=\d)/u, "$1");
  return listRouteNames()
    .filter((name) => {
      const upper = name.toUpperCase();
      return upper.startsWith(typed) || unpadded(upper).startsWith(typed);
    })
    .slice(0, 100);
}

/** Bodies of the REST actions the tools wrap, as far as the tools read them. */
interface StopBody {
  code?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  transfers?: { route?: string }[];
  timetable?: TimetableEntry[];
}

interface RouteStaticBody {
  route_short_name?: string;
  route_long_name?: string;
  color?: string;
  type?: string;
  stops?: {
    code: number;
    name?: string;
    loc?: number[];
    departures?: string[];
    schedule?: Partial<ScheduleByDayType>;
  }[][];
  shapes?: (number[][] | null | undefined)[];
}

interface RouteVehicleRow {
  id?: string | number;
  direction?: number | null;
  location?: number[];
  bearing?: unknown;
  lowfloor?: unknown;
}

interface ClosestStopRow {
  code: number;
  name: string;
  latitude: number;
  longitude: number;
  routes?: string[];
  distance_meters: number;
}

interface NearbyVehicleRow extends RouteVehicleRow {
  route?: string;
  vehicle_type?: string;
  routeId?: string;
  lat?: unknown;
  lng?: unknown;
}

interface VehicleBody {
  vehicleId?: string;
  route?: string | null;
  routeId?: string;
  licensePlate?: string | null;
  location?: number[];
  bearing?: unknown;
  direction?: number | null;
  arrivals?: { code: number; name?: string; arrival?: string | null; departure?: string | null }[];
}

function registerResources(server: McpServer): void {
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
      if (!/^\d+$/.test(String(code))) throw resourceNotFound(uri, `Stop ${code}`);
      const result = await runAction<StopBody>(getSingleStopAction, {
        stopCode: Number.parseInt(String(code), 10),
        query: { skipTimetableData: "true" },
      });
      if (result.statusCode >= 400) throw resourceNotFound(uri, `Stop ${code}`);
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
      complete: { name: completeRouteName },
    }),
    {
      title: "Route static info",
      description: "Static metadata for a route by short name (e.g. timetable://route/T30). Returns stop counts and color.",
      mimeType: "application/json",
    },
    async (uri, { name }) => {
      const result = await runAction<RouteStaticBody>(routeInfoStaticAction, {
        params: { name: String(name) },
      });
      if (result.statusCode >= 400) throw resourceNotFound(uri, `Route ${name}`);
      const b = result.body ?? {};
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            name: b.route_short_name ? formatRouteName(b.route_short_name) : null,
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

const zLatitude = (what: string) =>
  z.number().min(-90).max(90).describe(`Decimal latitude of the ${what}, WGS84 (e.g. 49.842 for central Lviv).`);
const zLongitude = (what: string) =>
  z.number().min(-180).max(180).describe(`Decimal longitude of the ${what}, WGS84 (e.g. 24.031 for central Lviv).`);

const zLowfloorOnly = (what: string) =>
  z
    .boolean()
    .optional()
    .describe(`Only low-floor ${what} (step-free: wheelchairs, prams). Timetable entries without a tracked vehicle are left out, since their floor is unknown. Default false.`);

const countToolCall = (tool: ToolName) => metrics.count("mcp.tool_call", 1, { tool });

/** Runs `fetch` unless a live cache entry exists; only successful results are cached. */
async function cachedTool(
  toolName: ToolName,
  cacheArgs: unknown,
  fetch: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const cached = getCached(toolName, cacheArgs);
  if (cached) return cached;
  const result = await fetch();
  if (!result.isError) setCached(toolName, cacheArgs, result);
  return result;
}

const ok = <N extends ToolName>(toolName: N, body: ToolData<N>): CallToolResult => formatToolResult(toolName, { statusCode: 200, body });

/** `{ disruptions }` to spread into a result when any touch these routes or stops, else nothing. */
function disruptionsField(filter: DisruptionFilter): { disruptions?: DisruptionOut[] } {
  const list = activeDisruptions(filter);
  return list.length ? { disruptions: list } : {};
}

/** RFC 1123 from the REST action → ISO 8601, like every other timestamp in these tools. */
const toIsoOrNull = (value: string | null | undefined): string | null => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Stops of the best trip, in riding order, for the map block. Transfers are
 * only listed when they beat every direct option, so a transfer option, when
 * present, is the best trip.
 */
type MapStop = ToolData<"find_routes_between">["map_stops"][number];

function bestTripStops(direct: TripLeg | undefined, transfer: TransferOption | undefined): MapStop[] {
  const at = (stop: StopSummary, role: MapStop["role"]): MapStop => ({ ...toStopObj(stop), role });
  if (transfer) {
    const [first, second] = transfer.legs;
    const sameStop = first.alight_stop.code === second.board_stop.code;
    return [
      at(first.board_stop, "board"),
      ...(sameStop
        ? [at(first.alight_stop, "transfer")]
        : [at(first.alight_stop, "transfer_alight"), at(second.board_stop, "transfer_board")]),
      at(second.alight_stop, "alight"),
    ];
  }
  return direct ? [at(direct.board_stop, "board"), at(direct.alight_stop, "alight")] : [];
}

const toStopObj = (s: {
  code: unknown;
  name?: string | null;
  lat?: unknown;
  lng?: unknown;
}): z.infer<typeof zStopObj> => ({
  id: String(s.code),
  name: s.name ?? null,
  lat: normalizeCoordinate(s.lat),
  lng: normalizeCoordinate(s.lng),
});

/** Live departures are looked up for this many direct options; transfer options are capped by the search. */
const MAX_LIVE_OPTIONS = 5;
const MAX_NEXT_DEPARTURES = 3;

/** The route search walks every route and stop; it only changes with the day's disruptions, so keep it a while. */
const SEARCH_TTL_MS = 5 * 60_000;
const _searchCache = new Map<string, { value: RoutesBetween; expiresAt: number }>();

function searchRoutes(from: TripEnd, to: TripEnd): RoutesBetween {
  const key = JSON.stringify([from, to]);
  const now = Date.now();
  const hit = _searchCache.get(key);
  if (hit && now <= hit.expiresAt) return hit.value;
  if (_searchCache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, entry] of _searchCache) if (now > entry.expiresAt) _searchCache.delete(k);
    while (_searchCache.size >= MAX_CACHE_ENTRIES) _searchCache.delete(_searchCache.keys().next().value!);
  }
  const value = findRoutesBetween(from, to, servedFilter());
  _searchCache.delete(key);
  _searchCache.set(key, { value, expiresAt: now + SEARCH_TTL_MS });
  return value;
}

/** One end of a trip from the tool arguments, or a message saying what is wrong with them. */
function tripEnd(which: "from" | "to", stopId: unknown, lat: number | undefined, lng: number | undefined): TripEnd | string {
  const hasPoint = lat != null || lng != null;
  if (stopId != null && hasPoint) return `Give \`${which}_stop_id\` or \`${which}_lat\` + \`${which}_lng\`, not both.`;
  if (stopId != null) return normalizeStopCode(stopId);
  if (lat != null && lng != null) return { lat: normalizeCoordinate(lat)!, lng: normalizeCoordinate(lng)! };
  if (hasPoint) return `\`${which}_lat\` and \`${which}_lng\` go together.`;
  return `Missing the trip's ${which === "from" ? "start" : "end"}: give \`${which}_stop_id\`, or \`${which}_lat\` + \`${which}_lng\`.`;
}

const hhmmAt = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

type NextDeparture = z.infer<typeof zNextDeparture>;

/**
 * A loader of a leg's next live departures from its boarding stop, the way
 * get_stop_realtime sees them: arrivals of that route heading the leg's way.
 * Each stop is fetched once however many options board there.
 */
function liveDeparturesLoader(): (leg: TripLeg) => Promise<NextDeparture[]> {
  const byStop = new Map<number, Promise<TimetableEntry[]>>();
  const timetable = (code: number) => {
    if (!byStop.has(code)) {
      byStop.set(
        code,
        runAction<StopBody>(getSingleStopAction, { stopCode: code, query: { skipTimetableData: "false" } })
          .then((r) => (r.statusCode < 400 && Array.isArray(r.body?.timetable) ? r.body!.timetable! : []))
          .catch(() => []),
      );
    }
    return byStop.get(code)!;
  };
  return async (leg) => {
    const entries = await timetable(leg.board_stop.code);
    return sortedArrivals(
      entries
        .filter((e) => {
          if (e.route !== leg.route) return false;
          const direction = typeof e.direction === "number" ? e.direction : typeof e.direction_id === "number" ? e.direction_id : null;
          return direction == null || direction === leg.direction;
        })
        .map(normalizeRealtimeArrival),
    )
      .slice(0, MAX_NEXT_DEPARTURES)
      .map((a) => ({ arrival_minutes: a.arrival_minutes, scheduled: a.scheduled, vehicle_id: a.vehicle_id, lowfloor: a.lowfloor }));
  };
}

/**
 * Minutes between consecutive vehicles of one direction, front to back. The
 * one behind is timed to the stop the one in front reaches next; the feed only
 * predicts each vehicle's next few stops, so a long gap shows as null.
 */
function liveGaps(vehicleEtas: StopEta[][], stopSequence: number[]): (number | null)[] {
  const progress = (etas: StopEta[]) => (etas.length ? stopSequence.indexOf(etas[0].code) : -1);
  const ordered = vehicleEtas.filter((e) => e.length).sort((a, b) => progress(b) - progress(a));
  return ordered.slice(1).map((behind, i) => {
    const ahead = ordered[i][0];
    const reach = behind.find((e) => e.code === ahead.code);
    return reach && reach.time >= ahead.time ? Math.round((reach.time - ahead.time) / 60_000) : null;
  });
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "get_stop_realtime",
    {
      title: "Get Stop Realtime",
      description:
        "Returns live arrivals at a stop: route, destination, vehicle type, minutes until arrival, and each vehicle's position. " +
        "Use this as the **default tool** when the user asks about arrivals, departures, or the next bus/tram at a specific stop. " +
        "Requires a numeric stop ID (shown on stop signage); use `search_stops` when you have a stop name, or `get_stops_around_location` when you have coordinates.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        stop_id: zStopId(),
        lowfloor_only: zLowfloorOnly("arrivals"),
      },
      outputSchema: OUTPUT_SCHEMAS.get_stop_realtime,
    },
    async ({ stop_id, lowfloor_only }) => {
      countToolCall("get_stop_realtime");
      const stopCode = normalizeStopCode(stop_id);
      const lowfloorOnly = lowfloor_only === true;
      return cachedTool("get_stop_realtime", { stop_id: stopCode, lowfloorOnly }, async () => {
        const actionResult = await runAction<StopBody>(getSingleStopAction, {
          stopCode,
          query: { skipTimetableData: "false" },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_stop_realtime", actionResult, NOT_FOUND_HINTS.stop(stopCode));
        }

        const body = actionResult.body ?? {};
        const arrivals = sortedArrivals(
          Array.isArray(body.timetable) ? body.timetable.map((item) => normalizeRealtimeArrival(item)) : [],
        ).filter((a) => !lowfloorOnly || a.lowfloor === true);
        const servingRoutes = [
          ...(Array.isArray(body.transfers) ? body.transfers.map((t) => t.route) : []),
          ...arrivals.map((a) => a.route),
        ].filter((r): r is string => !!r);
        return ok("get_stop_realtime", {
          stop: toStopObj({ code: body.code, name: body.name, lat: body.latitude, lng: body.longitude }),
          arrivals,
          lowfloor_only: lowfloorOnly,
          ...disruptionsField({ routes: servingRoutes, stops: [stopCode] }),
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
      // Keyed on the query as typed: the result echoes it back, so a lowercased
      // key would hand «опера» the summary cached for «Опера».
      return cachedTool("search_stops", { query, limit: max }, async () =>
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
        "Lists the routes from one place to another: which stop to board, where to get off, the direction's destination, stops in between, and the walk at each end — best first, walking counted. " +
        "Each end is a stop ID (`from_stop_id`) or coordinates (`from_lat` + `from_lng`), e.g. an address the user gave; a point covers every stop within a 600 m walk of it. " +
        "`options` are direct routes. `transfer_options` have exactly one interchange (never more): ride `legs[0]`, walk `transfer_walk_meters` (within a 300 m stop cluster, 0 when it is the same stop) to `legs[1].board_stop`, ride `legs[1]`. They are listed when there is no direct route or when they beat the best direct one. " +
        "Every option carries `schedule`: by the timetable, when to leave, when each leg boards and alights, when you arrive, and `total_minutes` door to door. Plan for now by default, or pass `depart_at` or `arrive_by` (\"HH:MM\" Lviv time today, or ISO 8601). " +
        "When planning for now, options also carry `next_departures`: the live next departures of the first leg from its boarding stop, so no separate `get_stop_realtime` call is needed. " +
        "`map_stops` holds the best trip's stops in riding order, each with a `role` (board, transfer — or transfer_alight + transfer_board when the interchange is a walk — and alight). " +
        "Use when the user asks how to get from A to B, which bus/tram goes from one place to another, how long it takes, or when to leave to be somewhere on time. " +
        "A stop end covers every stop within a 300 m walk of it, since a line's two directions often stop on opposite sides of a street under different names; `board_stop` says where to actually wait. " +
        "Routes the city has suspended, and stops a detour skips, are left out. " +
        "`walk_meters` is set when the two ends are within a 300 m walk of each other: no ride is searched then, so tell the user to walk. Otherwise both lists empty means the trip needs two or more transfers. " +
        "Get stop IDs with `search_stops` or `get_stops_around_location`.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        from_stop_id: zStopId().optional().describe("Stop ID where the trip starts. Give this or `from_lat` + `from_lng`."),
        from_lat: zLatitude("start point").optional(),
        from_lng: zLongitude("start point").optional(),
        to_stop_id: zStopId().optional().describe("Stop ID where the trip ends. Give this or `to_lat` + `to_lng`."),
        to_lat: zLatitude("destination").optional(),
        to_lng: zLongitude("destination").optional(),
        depart_at: z
          .string()
          .optional()
          .describe("Leave at this time: \"HH:MM\" Lviv time today, or ISO 8601. Default now. Not together with `arrive_by`."),
        arrive_by: z
          .string()
          .optional()
          .describe("Arrive by this time: \"HH:MM\" Lviv time today, or ISO 8601. Not together with `depart_at`."),
      },
      outputSchema: OUTPUT_SCHEMAS.find_routes_between,
    },
    async (args) => {
      countToolCall("find_routes_between");
      const from = tripEnd("from", args.from_stop_id, args.from_lat, args.from_lng);
      const to = tripEnd("to", args.to_stop_id, args.to_lat, args.to_lng);
      if (typeof from === "string") return toolError(from);
      if (typeof to === "string") return toolError(to);
      if (args.depart_at && args.arrive_by) return toolError("Give `depart_at` or `arrive_by`, not both.");
      const timeArg = args.arrive_by ?? args.depart_at;
      const at = timeArg ? parseTripTime(timeArg) : new Date();
      if (!at) return toolError(`Unreadable time «${timeArg}». Use "HH:MM" (Lviv time today) or ISO 8601, e.g. "2026-10-26T08:30:00+02:00".`);
      const when = args.arrive_by ? { arrive_by: at } : { depart_at: at };
      const live = !timeArg;

      return cachedTool("find_routes_between", { from, to, depart_at: args.depart_at ?? null, arrive_by: args.arrive_by ?? null }, async () => {
        const result = searchRoutes(from, to);
        if (result.missing != null) {
          return toolError(
            typeof result.missing === "number"
              ? NOT_FOUND_HINTS.stop(result.missing)
              : `No stop within ${POINT_WALK_RADIUS_METERS} m of the ${result.missing === "from" ? "start" : "destination"} point. Check the coordinates are in Lviv, or pick a stop with get_stops_around_location.`,
          );
        }
        const endpoint = (e: { code: number; name?: string; codes: number[] }, end: TripEnd) => ({
          id: String(e.code),
          name: e.name ?? null,
          stop_ids: e.codes.map(String),
          ...(typeof end === "number" ? {} : { point: end }),
        });
        const leg = (o: TripLeg) => ({
          route: o.route,
          vehicle_type: o.vehicle_type,
          direction: o.direction,
          destination: o.destination,
          board_stop: toStopObj(o.board_stop),
          alight_stop: toStopObj(o.alight_stop),
          stops_count: o.stops_count,
        });
        const scheduleLeg = (o: TripLeg) => ({
          route_id: o.route_id,
          board_code: o.board_stop.code,
          alight_code: o.alight_stop.code,
          stops_count: o.stops_count,
        });
        const transferOptions = result.transfer_options ?? [];

        // Live lookups are per boarding stop, shared between options boarding there.
        const departures = live ? liveDeparturesLoader() : null;
        const nextDepartures = async (o: TripLeg) =>
          departures ? { next_departures: await departures(o) } : {};

        const options = await Promise.all(
          result.options.map(async (o, i) => ({
            ...leg(o),
            walk_to_board_meters: o.walk_to_board_meters,
            walk_from_alight_meters: o.walk_from_alight_meters,
            schedule: scheduleTrip(
              [scheduleLeg(o)],
              { to_board_meters: o.walk_to_board_meters, transfer_meters: [], from_alight_meters: o.walk_from_alight_meters },
              when,
            ),
            ...(i < MAX_LIVE_OPTIONS ? await nextDepartures(o) : {}),
          })),
        );
        const transfers = await Promise.all(
          transferOptions.map(async (t) => ({
            legs: t.legs.map(leg),
            transfer_walk_meters: t.transfer_walk_meters,
            stops_count: t.stops_count,
            walk_to_board_meters: t.walk_to_board_meters,
            walk_from_alight_meters: t.walk_from_alight_meters,
            schedule: scheduleTrip(
              t.legs.map(scheduleLeg),
              { to_board_meters: t.walk_to_board_meters, transfer_meters: [t.transfer_walk_meters], from_alight_meters: t.walk_from_alight_meters },
              when,
            ),
            ...(await nextDepartures(t.legs[0])),
          })),
        );

        return ok("find_routes_between", {
          from: endpoint(result.from, from),
          to: endpoint(result.to, to),
          timing: { mode: args.arrive_by ? "arrive_by" : "depart_at", at: hhmmAt(at) },
          options,
          transfer_options: transfers,
          map_stops: bestTripStops(result.options[0], transferOptions[0]),
          ...(result.walk_meters != null ? { walk_meters: result.walk_meters } : {}),
          ...disruptionsField({
            routes: [...result.options, ...transferOptions.flatMap((t) => t.legs)].map((l) => l.route),
            stops: [...result.from.codes, ...result.to.codes],
          }),
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
        "Returns static route data: name, long name, vehicle type, colour, the ordered stop list for both directions, and the timetable of departures from the first stop (workday, Saturday and Sunday). " +
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
        const actionResult = await runAction<RouteStaticBody>(routeInfoStaticAction, {
          params: { name: route_name },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_route_static", actionResult, NOT_FOUND_HINTS.route(route_name));
        }

        const body = actionResult.body ?? {};
        const routeName = body.route_short_name ? formatRouteName(body.route_short_name) : null;
        return ok("get_route_static", {
          route: {
            name: routeName,
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
                    saturday: Array.isArray(s.schedule.saturday) ? s.schedule.saturday : [],
                    sunday: Array.isArray(s.schedule.sunday) ? s.schedule.sunday : [],
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
                  (shape): shape is number[][] => Array.isArray(shape) && shape.length > 0,
                ),
              }
            : {}),
          ...disruptionsField({ routes: [routeName ?? route_name] }),
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
        "`headways` sums up each direction: how many vehicles run, the live gaps between consecutive vehicles in minutes (front to back), and how often the timetable says it should run right now. " +
        "Use when the user asks \"where is my tram/bus right now?\", how many vehicles are running, how far the next one is, or how often a route runs. " +
        "Pass `direction` (0 or 1, as in `get_route_static`'s `stops`) to get only one way. " +
        "Prefer `get_stop_realtime` when the user is at a stop and wants arrival times there. " +
        "Requires a route short name (e.g. \"T30\", \"32A\") or numeric external ID.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route_name: zRouteName(),
        direction: z.coerce
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe("Only vehicles heading this way: 0 or 1, the index into get_route_static's `stops`. Omit for both."),
      },
      outputSchema: OUTPUT_SCHEMAS.get_route_realtime,
    },
    async ({ route_name, direction: wantedDirection }) => {
      countToolCall("get_route_realtime");
      const onlyDirection = wantedDirection ?? null;
      return cachedTool("get_route_realtime", { route_name, onlyDirection }, async () => {
        const actionResult = await runAction<RouteVehicleRow[]>(routeDynamicInfoAction, {
          params: { name: route_name },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_route_realtime", actionResult, NOT_FOUND_HINTS.route(route_name));
        }

        const route = resolveRoute(route_name);
        const destinations = route?.destinations ?? [null, null];
        const rawVehicles = (Array.isArray(actionResult.body) ? actionResult.body : []).filter(
          (v) => onlyDirection == null || v.direction === onlyDirection,
        );
        const etas = await etasForVehicles(rawVehicles.map((v) => v.id).filter(Boolean));

        const vehicles = rawVehicles.map((v, index) => {
          const direction = typeof v.direction === "number" ? v.direction : null;
          const next = etas[String(v.id)]?.[0];
          return {
            id: String(v.id ?? `vehicle-${index + 1}`),
            direction,
            destination: direction != null ? destinations[direction] ?? null : null,
            next_stop: next ? { id: String(next.code), name: next.name ?? null, arrival: new Date(next.time).toISOString() } : null,
            lat: normalizeCoordinate(v.location?.[0]),
            lng: normalizeCoordinate(v.location?.[1]),
            bearing: normalizeBearing(v.bearing),
            lowfloor: typeof v.lowfloor === "boolean" ? v.lowfloor : null,
          };
        });

        const headways = (onlyDirection != null ? [onlyDirection] : [0, 1]).map((direction) => ({
          direction,
          destination: destinations[direction] ?? null,
          vehicles: vehicles.filter((v) => v.direction === direction).length,
          gaps_minutes: liveGaps(
            vehicles.filter((v) => v.direction === direction).map((v) => etas[v.id] ?? []),
            route?.stops[direction] ?? [],
          ),
          scheduled_headway_minutes: route ? scheduledHeadway(route.external_id, direction) : null,
        }));

        return ok("get_route_realtime", {
          route_name: route?.name ?? route_name,
          destinations,
          direction: onlyDirection,
          vehicles,
          headways,
          ...disruptionsField({ routes: [route?.name ?? route_name] }),
          updated_at: new Date().toISOString(),
        });
      });
    },
  );

  server.registerTool(
    "get_disruptions",
    {
      title: "Get Disruptions",
      description:
        "Lists closures, detours and moved stops the city announced that are in force today: affected routes, the streets a detour uses, routes to take instead of a suspended one, reason, dates and source. " +
        "The GTFS stop lists and timetables do not reflect any of this. " +
        "Use when the user asks about road works, closures, detours, or why a route is not running or a vehicle is off its usual path. " +
        "Pass `route` and/or `stop_id` to get only the entries touching them; omit both for the whole city.",
      annotations: TOOL_ANNOTATIONS,
      inputSchema: {
        route: z
          .string()
          .min(1)
          .optional()
          .describe("Only disruptions on this route, by short name (e.g. \"Т30\", \"А34\"). Omit for all routes."),
        stop_id: zStopId().optional().describe("Only disruptions at this stop. Omit for all stops."),
      },
      outputSchema: OUTPUT_SCHEMAS.get_disruptions,
    },
    async ({ route, stop_id }) => {
      countToolCall("get_disruptions");
      const stopCode = stop_id != null ? normalizeStopCode(stop_id) : null;
      return cachedTool("get_disruptions", { route: route ?? null, stopCode }, async () => {
        const filtered = route != null || stopCode != null;
        // Filter by the resolved name: a numeric external ID would otherwise be
        // read as a bus number and match nothing.
        const routeName = route ? resolveRoute(route)?.name ?? route : null;
        return ok("get_disruptions", {
          route: routeName,
          stop_id: stopCode != null ? String(stopCode) : null,
          disruptions: activeDisruptions(
            filtered ? { routes: routeName ? [routeName] : [], stops: stopCode != null ? [stopCode] : [] } : undefined,
          ),
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
        const query: Record<string, string> = { latitude: String(latitude), longitude: String(longitude) };
        if (radius_meters != null) query.radius = String(radius_meters);

        const actionResult = await runAction<ClosestStopRow[]>(getClosestStopsAction, { query });
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
        lowfloor_only: zLowfloorOnly("vehicles"),
      },
      outputSchema: OUTPUT_SCHEMAS.get_nearby_vehicles,
    },
    async ({ latitude, longitude, radius_meters, route, limit, lowfloor_only }) => {
      countToolCall("get_nearby_vehicles");
      const radius = radius_meters ?? 500;
      const max = limit ?? 15;
      const lowfloorOnly = lowfloor_only === true;
      const cacheArgs = {
        latitude: normalizeCoordinate(latitude),
        longitude: normalizeCoordinate(longitude),
        radius,
        route: route ?? null,
        max,
        lowfloorOnly,
      };
      return cachedTool("get_nearby_vehicles", cacheArgs, async () => {
        const actionResult = await runAction<NearbyVehicleRow[]>(closestTransportAction, {
          query: { latitude: String(latitude), longitude: String(longitude) },
        });
        if (actionResult.statusCode >= 400) {
          return formatToolResult("get_nearby_vehicles", actionResult);
        }

        const resolvedRoute = route ? resolveRoute(route) : null;
        const wantedRoute = route ? resolvedRoute?.name ?? route : null;
        const inRange = (Array.isArray(actionResult.body) ? actionResult.body : [])
          .map((v) => {
            const lat = normalizeCoordinate(Array.isArray(v.location) ? v.location[0] : v.lat);
            const lng = normalizeCoordinate(Array.isArray(v.location) ? v.location[1] : v.lng);
            const distance = lat != null && lng != null ? Math.round(distanceMeters(latitude, longitude, lat, lng)) : null;
            return { v, lat, lng, distance };
          })
          .filter(({ distance }) => distance == null || distance <= radius)
          .filter(({ v }) => !wantedRoute || v.route === wantedRoute)
          .filter(({ v }) => !lowfloorOnly || v.lowfloor === true)
          .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

        // An empty answer for a misspelt route reads as "nothing nearby"; say
        // the route is unknown instead.
        if (route && !resolvedRoute && !inRange.length) {
          return toolError(NOT_FOUND_HINTS.route(route));
        }

        const shown = inRange.slice(0, max);
        const destinations = destinationsFor(
          shown.map(({ v }) => ({ routeId: v.routeId, direction: v.direction })),
        );

        return ok("get_nearby_vehicles", {
          center_lat: normalizeCoordinate(latitude),
          center_lng: normalizeCoordinate(longitude),
          radius_meters: radius,
          lowfloor_only: lowfloorOnly,
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
        const actionResult = await runAction<VehicleBody>(vehicleInfoAction, {
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

function registerPrompts(server: McpServer): void {
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
              "Answer:",
              "- If you can draw maps, render the result's `map` block: the stop plus each arriving vehicle at its `lat`/`lng`, labelled with route and ETA.",
              "- Otherwise list each vehicle's route, destination, ETA and how far it is from the stop, nearest first.",
              "- Reply in the language the user wrote in.",
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
              "Answer:",
              "- List arrivals by `arrival_minutes`, soonest first (the tool already returns them in that order).",
              "- Group repeated routes onto one line with their next few ETAs, e.g. \"Т30 → Сихів: 3, 11, 19 min\".",
              "- Show an arrival without an ETA (`arrival_minutes: null`) as \"no ETA\"; do not drop it.",
              "- If there are no arrivals, say so plainly.",
              "- Reply in the language the user wrote in.",
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
              "Answer:",
              "- Follow the result's `ui_blocks` order: first block `map`, second block `arrival_list`. Without map support, skip the map and keep the list.",
              "- Use the same route labels and ETA values in both.",
              "- Any arrival without an ETA (`arrival_minutes: null`) must be shown as \"no ETA\", not dropped.",
              "- Reply in the language the user wrote in.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

const userPrompt = (description: string, lines: string[]) => ({
  description,
  messages: [{ role: "user" as const, content: { type: "text" as const, text: lines.join("\n") } }],
});

function registerWorkflowPrompts(server: McpServer): void {
  server.registerPrompt(
    "plan-trip",
    {
      title: "Plan a Trip",
      description: "Find routes (direct or with one transfer) between two places in Lviv, the next live departures and when to leave.",
      argsSchema: {
        from: z.string().min(1).describe("Where the trip starts: stop name, landmark, numeric stop ID, or \"lat,lng\"."),
        to: z.string().min(1).describe("Where the trip ends: stop name, landmark, numeric stop ID, or \"lat,lng\"."),
        arrive_by: z.string().optional().describe("Optional: \"HH:MM\" (Lviv time) the rider has to be there by."),
      },
    },
    ({ from, to, arrive_by }) =>
      userPrompt("Trip planning across search_stops and find_routes_between.", [
        `How do I get from «${from}» to «${to}» by public transport in Lviv${arrive_by ? `, arriving by ${arrive_by}` : ""}?`,
        "",
        "Tool workflow:",
        "1) Resolve each end: a number is a stop ID; \"lat,lng\" is a point, passed as `*_lat`/`*_lng`; otherwise call `search_stops`. When several different places match, ask which one is meant instead of guessing.",
        `2) Call \`find_routes_between\` with the two ends${arrive_by ? ` and \`arrive_by: "${arrive_by}"\`` : ""}.`,
        "3) If `walk_meters` is set, the two stops are a short walk apart: say so with the distance and stop there. Otherwise, if both `options` and `transfer_options` are empty, say the trip needs more than one transfer and stop there.",
        "4) Otherwise take the best direct option, or the first transfer option when there is no direct one or it is listed as better.",
        "",
        "Answer:",
        "- Lead with the best option: route, where to board (and the walk to it), where to get off, number of stops.",
        "- For a transfer, name the interchange: where to get off the first vehicle, the walk to the second stop (if any), and the second route and its direction.",
        "- Give its `next_departures` (live, minutes from now); if there are none, say so. Then its `schedule`: when to leave and when you arrive, as timetable estimates.",
        "- Mention any `disruptions`.",
        "- List up to two alternatives in one line each.",
        "- Reply in the language the user wrote in.",
      ]),
  );

  server.registerPrompt(
    "route-status",
    {
      title: "Route Status",
      description: "Where the vehicles of one route are right now.",
      argsSchema: {
        route_name: completable(zRouteName(), completeRouteName),
      },
    },
    ({ route_name }) =>
      userPrompt("Live overview of one route via get_route_realtime.", [
        `What is happening on route ${route_name} in Lviv right now?`,
        "",
        "Tool workflow:",
        `1) Call \`get_route_realtime\` with \`route_name=${route_name}\`.`,
        "",
        "Answer:",
        "- How many vehicles are running, split by `destination`.",
        "- For each direction, the next stop of each vehicle with its estimated arrival time.",
        "- From `headways`: how far apart the vehicles are, and how that compares with `scheduled_headway_minutes`; call out a gap much longer than the timetable's.",
        "- Mention low-floor vehicles when `lowfloor` is true.",
        "- If no vehicles are running, say the route has no live vehicles right now.",
        "- Reply in the language the user wrote in.",
      ]),
  );
}

export function createTimetableMcpServer(): McpServer {
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
  registerWorkflowPrompts(server);
  return server;
}

/**
 * Some clients serialise an absent `params` as an explicit null. The JSON-RPC
 * schema in the SDK only accepts an object there, so the whole request is
 * rejected with "Parse error: Invalid JSON-RPC message" before it ever reaches
 * a handler. Dropping the null is equivalent to the client having omitted the
 * key, so accept it instead of failing the request.
 */
function dropNullParams(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map(dropNullParams);
  }

  if (body === null || typeof body !== "object" || (body as { params?: unknown }).params !== null) {
    return body;
  }

  const { params, ...rest } = body as { params: null };
  return rest;
}

// The transport answers 406 unless Accept names both application/json and
// text/event-stream. Plenty of real clients send neither (aiohttp scripts,
// registry probes): 1,011 of them were turned away in one week, 9% of all
// POST /mcp. The server is stateless and every response is a single message,
// so plain JSON serves them fully. The transport reads the header from
// rawHeaders, so that is what has to be rewritten.
const FULL_ACCEPT = "application/json, text/event-stream";

/** Widens Accept for the transport; true when the client can't take an SSE stream. */
export function normalizeMcpAccept(req: Request): boolean {
  const accept = req.headers.accept ?? "";
  const wantsSse = /text\/event-stream/i.test(accept);
  if (wantsSse && /application\/json/i.test(accept)) return false;

  req.headers.accept = FULL_ACCEPT;
  const raw = req.rawHeaders.filter((_, i, all) => {
    const name = i % 2 === 0 ? all[i] : all[i - 1];
    return name.toLowerCase() !== "accept";
  });
  raw.push("Accept", FULL_ACCEPT);
  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw);
  return !wantsSse;
}

export async function handleMcpPostRequest(req: Request, res: Response): Promise<void> {
  const jsonOnly = normalizeMcpAccept(req);
  const server = createTimetableMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: jsonOnly,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, dropNullParams(req.body));
  } finally {
    await transport.close();
    await server.close();
  }
}

export function buildMcpServerCard(baseUrl: string) {
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
