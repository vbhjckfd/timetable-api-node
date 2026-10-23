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
