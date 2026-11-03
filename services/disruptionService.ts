import * as z from "zod/v4";
import rawDisruptions from "../data/disruptions.json" with { type: "json" };
import { formatRouteName, normalizeRouteName, routeNameToUrlFriendly } from "../utils/appHelpers.ts";

/**
 * Closures, detours and moved stops the city announced, from data/disruptions.json.
 *
 * The GTFS feed does not carry them: a detour shows up only as odd vehicle
 * tracks, a suspended route only as a 404. The file is edited by hand and
 * ships with a deploy; an entry stops being served the day after its `until`,
 * so a stale one hides itself.
 */

const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zRouteNames = z.array(z.string().min(1)).default([]);

export const zDisruptionEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(["suspended", "detour", "stop_moved", "stop_closed"]),
  reason: z.string().min(1),
  since: zIsoDate,
  until: zIsoDate.nullable().default(null),
  until_text: z.string().nullable().default(null),
  routes: zRouteNames,
  stops: z.array(z.number().int().positive()).default([]),
  alternatives: zRouteNames,
  detour: z
    .object({
      via: z.array(z.string().min(1)).default([]),
      skipped_stops: z.array(z.number().int().positive()).default([]),
    })
    .nullable()
    .default(null),
  // Where the entry applies: the stretch a detour replaces. Trip planning
  // attaches an entry with an area only to a ride that passes through it.
  area: z
    .object({ lat: z.number(), lng: z.number(), radius_meters: z.number().positive() })
    .nullable()
    .default(null),
  note: z.string().nullable().default(null),
  source: z.string().nullable().default(null),
  url: z.url().nullable().default(null),
});

export type DisruptionEntry = z.infer<typeof zDisruptionEntry>;

/** A route as both clients need it: `name` for people and models, `id` for lad.lviv.ua URLs. */
export interface DisruptionRoute {
  name: string;
  id: string;
}

export interface Disruption extends Omit<DisruptionEntry, "routes" | "alternatives"> {
  routes: DisruptionRoute[];
  alternatives: DisruptionRoute[];
}

const toRoute = (name: string): DisruptionRoute => {
  const canonical = normalizeRouteName(name);
  return { name: formatRouteName(canonical), id: routeNameToUrlFriendly(canonical) };
};

/** Throws on a malformed file, so a bad edit fails the deploy instead of a request. */
export function parseDisruptions(raw: unknown): Disruption[] {
  const entries = z.array(zDisruptionEntry).parse(raw);
  const ids = new Set<string>();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`Duplicate disruption id «${e.id}»`);
    ids.add(e.id);
    if (e.until && e.until < e.since) throw new Error(`Disruption «${e.id}» ends before it starts`);
    // Tools attach an entry by the routes or stops in their result, so one
    // naming neither would only ever show in the unfiltered city-wide list.
    if (!e.routes.length && !e.stops.length && !e.detour?.skipped_stops.length) {
      throw new Error(`Disruption «${e.id}» names no route or stop`);
    }
  }
  return entries.map((e) => ({ ...e, routes: e.routes.map(toRoute), alternatives: e.alternatives.map(toRoute) }));
}

const ALL = parseDisruptions(rawDisruptions);

/** Today's date in Lviv as YYYY-MM-DD: an entry's dates are local calendar days. */
export function kyivDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(now);
}

export interface DisruptionFilter {
  /** Route names in any form the API accepts ("Т30", "T30", "А1"). */
  routes?: Iterable<string>;
  stops?: Iterable<number>;
}

/**
 * Entries in force today. With a filter, only those touching one of its routes
 * or stops; an empty filter matches nothing, so a tool can pass what it has.
 */
export function activeDisruptions(
  filter?: DisruptionFilter,
  now: Date = new Date(),
  entries: Disruption[] = ALL,
): Disruption[] {
  const today = kyivDate(now);
  const active = entries.filter((e) => e.since <= today && (!e.until || today <= e.until));
  if (!filter) return active;

  const ids = new Set([...(filter.routes ?? [])].map((name) => toRoute(String(name)).id));
  const stops = new Set(filter.stops ?? []);
  return active.filter(
    (e) =>
      e.routes.some((r) => ids.has(r.id)) ||
      e.stops.some((s) => stops.has(s)) ||
      (e.detour?.skipped_stops ?? []).some((s) => stops.has(s)),
  );
}

/**
 * Whether a route calls at a stop today, for trip planning. A suspended route
 * serves nothing; a detour skips its `skipped_stops`; a closed stop is closed
 * to the routes listed, or to every route when none are.
 */
export function servedFilter(
  now: Date = new Date(),
  entries: Disruption[] = ALL,
): (routeName: string, stopCode: number) => boolean {
  const suspended = new Set<string>();
  const closedToAll = new Set<number>();
  const closedTo = new Map<string, Set<number>>();
  const close = (routeId: string, stops: number[]) => {
    if (!closedTo.has(routeId)) closedTo.set(routeId, new Set());
    for (const s of stops) closedTo.get(routeId)!.add(s);
  };

  for (const e of activeDisruptions(undefined, now, entries)) {
    if (e.kind === "suspended") {
      for (const r of e.routes) suspended.add(r.id);
    } else if (e.kind === "stop_closed") {
      if (e.routes.length) for (const r of e.routes) close(r.id, e.stops);
      else for (const s of e.stops) closedToAll.add(s);
    }
    if (e.detour?.skipped_stops.length) {
      for (const r of e.routes) close(r.id, e.detour.skipped_stops);
    }
  }

  // Trip planning asks once per stop of every route: normalise each name once.
  const ids = new Map<string, string>();
  return (routeName, stopCode) => {
    if (closedToAll.has(stopCode)) return false;
    if (!ids.has(routeName)) ids.set(routeName, toRoute(routeName).id);
    const id = ids.get(routeName)!;
    return !suspended.has(id) && !closedTo.get(id)?.has(stopCode);
  };
}

type Area = NonNullable<DisruptionEntry["area"]>;

/** Whether a path of [lat, lng] points comes within the area: a vertex or any segment between two. */
export function pathCrossesArea(path: [number, number][], area: Area): boolean {
  // Flat metres around the centre: areas span a street or two, so the error is nil.
  const ky = 111_320;
  const kx = ky * Math.cos((area.lat * Math.PI) / 180);
  const pts = path.map(([lat, lng]) => [(lng - area.lng) * kx, (lat - area.lat) * ky]);
  const r2 = area.radius_meters ** 2;
  return pts.some(([x, y], i) => {
    if (x * x + y * y <= r2) return true;
    if (i === 0) return false;
    const [px, py] = pts[i - 1];
    const dx = x - px;
    const dy = y - py;
    const len2 = dx * dx + dy * dy;
    if (!len2) return false;
    const t = Math.max(0, Math.min(1, -(px * dx + py * dy) / len2));
    const cx = px + t * dx;
    const cy = py + t * dy;
    return cx * cx + cy * cy <= r2;
  });
}

/** A leg of a planned trip: its route and the stops it rides, board to alight, as [lat, lng]. */
export interface RiddenLeg {
  route: string;
  ride_path?: [number, number][];
}

/**
 * Entries in force today that a planned trip runs into. By stop, as
 * activeDisruptions; by route only when the leg rides through the entry's
 * area, if it has one. А84 is detoured off Мазепи on its northern end, so a
 * ride from the centre to Рудно on it must not carry that detour.
 */
export function tripDisruptions(
  legs: RiddenLeg[],
  stops: Iterable<number>,
  now: Date = new Date(),
  entries: Disruption[] = ALL,
): Disruption[] {
  const stopSet = new Set(stops);
  const ridden = legs.map((l) => ({ id: toRoute(l.route).id, path: l.ride_path }));
  return activeDisruptions(undefined, now, entries).filter(
    (e) =>
      e.stops.some((s) => stopSet.has(s)) ||
      (e.detour?.skipped_stops ?? []).some((s) => stopSet.has(s)) ||
      ridden.some(
        (l) =>
          e.routes.some((r) => r.id === l.id) &&
          // A leg with no path cannot be placed: tell the rider rather than hide it.
          (!e.area || !l.path?.length || pathCrossesArea(l.path, e.area)),
      ),
  );
}
