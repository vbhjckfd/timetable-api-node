import db from "../connections/timetableSqliteDb.js";
import { getArrivalTimes } from "./microgizService.js";
import {
  distanceMeters,
  formatRouteName,
  getRouteType,
  normalizeRouteName,
} from "../utils/appHelpers.js";

/**
 * Lookups over the imported timetable that the REST actions have no endpoint
 * for: stop search by name, direct routes between two stops, and the terminus
 * a vehicle is heading to. Used by the MCP tools.
 */

const stops = () => db.getCollection("stops");
const routes = () => db.getCollection("routes");

/**
 * Case- and apostrophe-insensitive, so "Площа Ринок", "площа ринок" and
 * "Pidvalna" all hit, and "Маріїʼ" typed with any of ' ’ ʼ matches.
 */
function foldName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’'ʼ`"«»]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stopRoutes(stop) {
  return [...new Set((stop.transfers ?? []).map((t) => t.route).filter(Boolean))].sort();
}

function stopSummary(stop) {
  const [lat, lng] = stop.location.coordinates;
  return {
    code: stop.code,
    name: stop.name,
    eng_name: stop.eng_name ?? null,
    lat,
    lng,
    routes: stopRoutes(stop),
  };
}

/**
 * Stop names are inflected ("Театр опери та балету"), riders type the
 * nominative ("опера"). Dropping trailing vowels and soft signs from longer
 * words lets both meet on the stem ("опер"); short words stay whole so "Ринок"
 * does not widen into "Рин".
 */
function stemWord(word) {
  const stem = word.replace(/[аяоеєиіїуюьйaeiouy]+$/u, "");
  return stem.length >= 4 ? stem : word;
}

/**
 * Every word of the query has to appear in the name, in any order. A name
 * starting with the first word ranks first, then names where every word
 * starts a word ("вокзал" in "Залізничний вокзал"), then names that only
 * contain them mid-word ("Автовокзал"); within a rank, shorter names first (closest to what was typed), then by
 * code for a stable order. The same name usually covers both sides of the
 * street under different codes, so every one of them is returned rather than
 * collapsing them.
 */
export function searchStops(query, limit = 10) {
  const words = foldName(query).split(" ").filter(Boolean).map(stemWord);
  if (!words.length) return [];

  return stops()
    .find({})
    .map((stop) => {
      const names = [foldName(stop.name), foldName(stop.eng_name)].filter(
        (n) => n && words.every((w) => n.includes(w)),
      );
      if (!names.length) return null;
      const atWordStart = (n) => words.every((w) => ` ${n}`.includes(` ${w}`));
      const rank = names.some((n) => n.startsWith(words[0])) ? 0 : names.some(atWordStart) ? 1 : 2;
      return { stop, rank };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        String(a.stop.name).length - String(b.stop.name).length ||
        a.stop.code - b.stop.code,
    )
    .slice(0, limit)
    .map(({ stop }) => stopSummary(stop));
}

export function routeTerminusName(route, direction) {
  const code = route?.stops_by_shape?.[String(direction)]?.at(-1);
  if (code == null) return null;
  return stops().findOne({ code })?.name ?? null;
}

/** Same lookup the REST route endpoints use: numeric → external ID, else short name. */
export function resolveRoute(name) {
  const query = Number(name)
    ? { external_id: String(name) }
    : { short_name: normalizeRouteName(String(name)) };
  const route = routes().findOne(query);
  if (!route) return null;
  return {
    external_id: route.external_id,
    name: formatRouteName(route.short_name),
    destinations: [0, 1].map((direction) => routeTerminusName(route, direction)),
  };
}

/**
 * Display names of every route ("Т30", "А01", "Н2"), sorted, for MCP argument
 * completion. Routes only change with a GTFS import, so callers may keep it.
 */
export function listRouteNames() {
  return [...new Set(routes().find({}).map((r) => formatRouteName(r.short_name)))].sort((a, b) =>
    a.localeCompare(b, "uk", { numeric: true }),
  );
}

/** Terminus name per `${routeId}:${direction}` for a batch of live vehicles. */
export function destinationsFor(pairs) {
  const byId = new Map();
  const result = {};
  for (const { routeId, direction } of pairs) {
    if (routeId == null || direction == null) continue;
    const key = `${routeId}:${direction}`;
    if (key in result) continue;
    if (!byId.has(routeId)) {
      byId.set(routeId, routes().findOne({ external_id: String(routeId) }));
    }
    result[key] = routeTerminusName(byId.get(routeId), direction);
  }
  return result;
}

/** How long after its scheduled time a stop still counts as ahead of the vehicle. */
export const PASSED_GRACE_MS = 30_000;

/**
 * The soonest stop still ahead of each vehicle. A vehicle can carry several
 * trip updates at once (the trip it is on and the one it runs next), so the
 * pick is the earliest time across all of them, not the first entity. A stop
 * whose time passed more than 30 s ago is behind the vehicle even if the feed
 * has not dropped it yet.
 */
export async function nextStopsForVehicles(vehicleIds, now = Date.now()) {
  const wanted = new Set(vehicleIds.map(String));
  if (!wanted.size) return {};

  const updates = (await getArrivalTimes()).filter((e) =>
    wanted.has(String(e.tripUpdate?.vehicle?.id)),
  );

  const nextByVehicle = {};
  for (const entity of updates) {
    const vehicleId = String(entity.tripUpdate.vehicle.id);
    for (const update of entity.tripUpdate.stopTimeUpdate ?? []) {
      const time = Number((update.arrival ?? update.departure)?.time) * 1000;
      if (!Number.isFinite(time) || time < now - PASSED_GRACE_MS) continue;
      if (!nextByVehicle[vehicleId] || time < nextByVehicle[vehicleId].time) {
        nextByVehicle[vehicleId] = { stopId: update.stopId, time };
      }
    }
  }

  const microgizIds = Object.values(nextByVehicle).map((u) => u.stopId);
  const stopsById = Object.fromEntries(
    stops()
      .find({ microgiz_id: { $in: microgizIds } })
      .map((s) => [s.microgiz_id, s]),
  );

  const result = {};
  for (const [vehicleId, { stopId, time }] of Object.entries(nextByVehicle)) {
    const stop = stopsById[stopId];
    if (!stop) continue;
    result[vehicleId] = {
      code: stop.code,
      name: stop.name,
      arrival: new Date(time).toISOString(),
    };
  }
  return result;
}

/**
 * Riders pick a place, not a platform. The two directions of a line often
 * stop on opposite sides of a street or square under different names (Т01
 * leaves «Площа Ринок» from «Руська», 180 m away), so each end is widened to
 * every stop within walking distance of the one given.
 */
export const WALK_RADIUS_METERS = 300;

/**
 * An interchange is a stop cluster, not a single stop: getting off one line
 * and walking across the square to another counts, as long as the walk stays
 * within this radius.
 */
export const TRANSFER_RADIUS_METERS = 300;

/** Ranking weight: this much walking costs as much as riding one more stop. */
const WALK_METERS_PER_STOP = 150;

/** Ranking weight of the interchange itself (waiting for the second vehicle), in stops. */
const TRANSFER_PENALTY_STOPS = 5;

const MAX_TRANSFER_OPTIONS = 5;

function stopsWithinWalk(code) {
  const origin = stops().findOne({ code });
  if (!origin) return null;
  const [lat, lng] = origin.location.coordinates;
  const nearby = new Map();
  for (const s of stops().find({})) {
    const [sLat, sLng] = s.location.coordinates;
    const walk = s.code === origin.code ? 0 : Math.round(distanceMeters(lat, lng, sLat, sLng));
    if (walk <= WALK_RADIUS_METERS) nearby.set(s.code, { stop: s, walk });
  }
  return { origin, nearby };
}

/**
 * Stops within `radius` of a stop, itself included, via a grid of
 * radius-sized cells so each lookup only measures the 3×3 cells around it.
 */
function clusterIndex(allStops, radius) {
  const cellLat = radius / 111_320;
  const meanLat = allStops.reduce((sum, s) => sum + s.location.coordinates[0], 0) / (allStops.length || 1);
  const cellLng = cellLat / Math.max(Math.cos((meanLat * Math.PI) / 180), 0.01);
  const cellOf = (lat, lng) => [Math.floor(lat / cellLat), Math.floor(lng / cellLng)];

  const cells = new Map();
  const byCode = new Map();
  for (const s of allStops) {
    const [lat, lng] = s.location.coordinates;
    const key = cellOf(lat, lng).join(":");
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(s);
    byCode.set(s.code, s);
  }

  return (code) => {
    const origin = byCode.get(code);
    if (!origin) return [];
    const [lat, lng] = origin.location.coordinates;
    const [cy, cx] = cellOf(lat, lng);
    const result = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const s of cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const [sLat, sLng] = s.location.coordinates;
          const walk = s.code === code ? 0 : Math.round(distanceMeters(lat, lng, sLat, sLng));
          if (walk <= radius) result.push({ stop: s, walk });
        }
      }
    }
    return result;
  };
}

/** Every route direction as an ordered stop list. */
function routeDirections() {
  const result = [];
  for (const route of routes().find({})) {
    for (const key of ["0", "1"]) {
      const seq = route.stops_by_shape?.[key] ?? [];
      if (seq.length > 1) result.push({ route, key, seq, id: `${route.external_id}:${key}` });
    }
  }
  return result;
}

const walkCost = (meters) => meters / WALK_METERS_PER_STOP;

function keepCheapest(map, stopCode, leg) {
  if (!map.has(stopCode)) map.set(stopCode, new Map());
  const legs = map.get(stopCode);
  const current = legs.get(leg.dir.id);
  if (!current || leg.cost < current.cost) legs.set(leg.dir.id, leg);
}

/**
 * First legs: for every stop reachable without a transfer from a stop near
 * the origin, the cheapest ride there per route direction. The last stop of a
 * direction is never a boarding point.
 */
function legsFromOrigin(dirs, nearby) {
  const reach = new Map();
  for (const dir of dirs) {
    let board = null;
    for (let i = 0; i < dir.seq.length; i++) {
      if (board) {
        const stops_count = i - board.index;
        keepCheapest(reach, dir.seq[i], {
          dir,
          board,
          alight: { index: i, code: dir.seq[i], walk: 0 },
          stops_count,
          cost: stops_count + walkCost(board.walk),
        });
      }
      const candidate = nearby.get(dir.seq[i]);
      if (
        candidate &&
        i < dir.seq.length - 1 &&
        (!board || walkCost(candidate.walk) - i < walkCost(board.walk) - board.index)
      ) {
        board = { index: i, code: dir.seq[i], walk: candidate.walk };
      }
    }
  }
  return reach;
}

/** Second legs: for every stop, the cheapest ride from it to a stop near the destination, per route direction. */
function legsToDestination(dirs, nearby) {
  const reach = new Map();
  for (const dir of dirs) {
    let alight = null;
    for (let i = dir.seq.length - 1; i >= 0; i--) {
      if (alight) {
        const stops_count = alight.index - i;
        keepCheapest(reach, dir.seq[i], {
          dir,
          board: { index: i, code: dir.seq[i], walk: 0 },
          alight,
          stops_count,
          cost: stops_count + walkCost(alight.walk),
        });
      }
      const candidate = nearby.get(dir.seq[i]);
      if (candidate && (!alight || walkCost(candidate.walk) + i < walkCost(alight.walk) + alight.index)) {
        alight = { index: i, code: dir.seq[i], walk: candidate.walk };
      }
    }
  }
  return reach;
}

/**
 * Direct routes, plus routes with exactly one interchange. A direct route
 * qualifies when, in one direction, a stop near the origin comes before a
 * stop near the destination; per route and direction the cheapest
 * board/alight pair wins, walking included. A transfer option rides one line
 * to some stop, walks at most TRANSFER_RADIUS_METERS within that stop's
 * cluster, and rides a different line on. A line that already goes there
 * directly never appears as either leg of a transfer, and transfers are only
 * listed when no direct option exists or they beat the best one. The last
 * stop of a direction is where riders get off, so it never counts as a place
 * to board (same rule as routesThroughStop).
 */
export function findRoutesBetween(fromCode, toCode) {
  const from = stopsWithinWalk(fromCode);
  const to = stopsWithinWalk(toCode);
  if (!from || !to) {
    return { from: null, to: null, options: [], transfer_options: [], missing: !from ? fromCode : toCode };
  }

  const dirs = routeDirections();
  const stopsByCode = new Map(stops().find({}).map((s) => [s.code, s]));
  const stopOut = (code) => stopSummary(stopsByCode.get(code));

  const cost = (o) => o.stops_count + walkCost(o.walk_to_board_meters + o.walk_from_alight_meters);

  const options = [];
  const directIds = new Set();
  for (const dir of dirs) {
    const { seq } = dir;
    let best = null;
    for (let i = 0; i < seq.length - 1; i++) {
      const board = from.nearby.get(seq[i]);
      if (!board) continue;
      for (let j = i + 1; j < seq.length; j++) {
        const alight = to.nearby.get(seq[j]);
        if (!alight) continue;
        const option = {
          stops_count: j - i,
          walk_to_board_meters: board.walk,
          walk_from_alight_meters: alight.walk,
          board,
          alight,
        };
        if (!best || cost(option) < cost(best)) best = option;
      }
    }
    if (!best) continue;
    directIds.add(dir.id);
    options.push({
      route: formatRouteName(dir.route.short_name),
      vehicle_type: getRouteType(dir.route.short_name),
      direction: Number(dir.key),
      destination: routeTerminusName(dir.route, dir.key),
      board_stop: stopSummary(best.board.stop),
      alight_stop: stopSummary(best.alight.stop),
      stops_count: best.stops_count,
      walk_to_board_meters: best.walk_to_board_meters,
      walk_from_alight_meters: best.walk_from_alight_meters,
    });
  }

  options.sort((a, b) => cost(a) - cost(b) || a.route.localeCompare(b.route));

  // --- One interchange ---
  const indirect = dirs.filter((d) => !directIds.has(d.id));
  const firstLegs = legsFromOrigin(indirect, from.nearby);
  const secondLegs = legsToDestination(indirect, to.nearby);
  const cluster = clusterIndex([...stopsByCode.values()], TRANSFER_RADIUS_METERS);

  const bestByPair = new Map();
  for (const [alightCode, legs1] of firstLegs) {
    for (const { stop, walk } of cluster(alightCode)) {
      const legs2 = secondLegs.get(stop.code);
      if (!legs2) continue;
      for (const leg1 of legs1.values()) {
        for (const leg2 of legs2.values()) {
          if (leg1.dir.route.external_id === leg2.dir.route.external_id) continue;
          const total = leg1.cost + leg2.cost + walkCost(walk) + TRANSFER_PENALTY_STOPS;
          const pair = `${leg1.dir.id}>${leg2.dir.id}`;
          const current = bestByPair.get(pair);
          if (!current || total < current.total) bestByPair.set(pair, { leg1, leg2, walk, total });
        }
      }
    }
  }

  const legOut = ({ dir, board, alight, stops_count }) => ({
    route: formatRouteName(dir.route.short_name),
    vehicle_type: getRouteType(dir.route.short_name),
    direction: Number(dir.key),
    destination: routeTerminusName(dir.route, dir.key),
    board_stop: stopOut(board.code),
    alight_stop: stopOut(alight.code),
    stops_count,
  });

  const bestDirect = options.length ? cost(options[0]) : Infinity;
  const transfer_options = [...bestByPair.values()]
    .filter((t) => t.total < bestDirect)
    .sort(
      (a, b) =>
        a.total - b.total ||
        `${a.leg1.dir.route.short_name}${a.leg2.dir.route.short_name}`.localeCompare(
          `${b.leg1.dir.route.short_name}${b.leg2.dir.route.short_name}`,
        ),
    )
    .slice(0, MAX_TRANSFER_OPTIONS)
    .map(({ leg1, leg2, walk }) => ({
      legs: [legOut(leg1), legOut(leg2)],
      transfer_walk_meters: walk,
      stops_count: leg1.stops_count + leg2.stops_count,
      walk_to_board_meters: leg1.board.walk,
      walk_from_alight_meters: leg2.alight.walk,
    }));

  const endpoint = ({ origin, nearby }) => ({
    code: origin.code,
    name: origin.name,
    codes: [...nearby.keys()].sort((a, b) => a - b),
  });
  return { from: endpoint(from), to: endpoint(to), options, transfer_options };
}
