import { getShapes, getTrips, getCalendars } from "gtfs";
import type { Calendar, Trip } from "gtfs";
import type { VehicleEntity } from "../services/microgizService.ts";
import type { LatLng, RouteDoc, VehicleType } from "../types/domain.ts";

export function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The daily import finishes at 01:15 UTC. Built from UTC fields throughout:
// mixing the local date (Europe/Kyiv in the image) into Date.UTC skipped a
// day between local midnight and 01:15 UTC, and always added one even when
// today's import was still ahead.
function nextImportDate(now: Date = new Date()): Date {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    1,
    15,
    0,
  );
  return new Date(today > now.getTime() ? today : today + 24 * 3600 * 1000);
}

export function secondsUntilImportDone(now: Date = new Date()): number {
  return Math.round((nextImportDate(now).getTime() - now.getTime()) / 1000);
}

export async function getTodayServiceIds(): Promise<string[]> {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  const dayname = days[new Date().getDay()] as keyof Calendar;

  const service_ids = (
    await getCalendars(
      {
        [dayname]: 1,
      },
      ["service_id"],
    )
  ).map((i) => i.service_id);

  return service_ids;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/**
 * Services that run on at least one day of the week. The import keys trip
 * lookups on these rather than on today's services: the data has to answer
 * for every day it stays deployed, and the daily refresh skips the rebuild
 * when the feed is unchanged, so a timetable built on a Sunday would
 * otherwise know no Monday trip.
 */
export async function getAllServiceIds(): Promise<string[]> {
  return Object.keys(await getServiceDayCounts());
}

/** Days a week each service runs, for services that run on at least one. */
export async function getServiceDayCounts(): Promise<Record<string, number>> {
  const calendars = await getCalendars({}, ["service_id", ...WEEKDAYS]);
  const counts: Record<string, number> = {};
  for (const c of calendars) {
    const days = WEEKDAYS.filter((day) => c[day] === 1).length;
    if (days) counts[c.service_id] = Math.max(counts[c.service_id] ?? 0, days);
  }
  return counts;
}

export async function getWorkdayServiceIds(): Promise<string[]> {
  return (await getCalendars({ monday: 1 }, ["service_id"])).map(
    (i) => i.service_id,
  );
}

export async function getSaturdayServiceIds(): Promise<string[]> {
  return (await getCalendars({ saturday: 1 }, ["service_id"])).map(
    (i) => i.service_id,
  );
}

export async function getSundayServiceIds(): Promise<string[]> {
  return (await getCalendars({ sunday: 1 }, ["service_id"])).map(
    (i) => i.service_id,
  );
}

// Saturday and Sunday combined. Some routes run different Saturday and Sunday
// timetables (service 32/160 Sat-only, 64/192 Sun-only, 63/191 Mon–Sat), so
// this union can interleave two different days — prefer the per-day helpers.
export async function getWeekendServiceIds(): Promise<string[]> {
  const [sat, sun] = await Promise.all([
    getCalendars({ saturday: 1 }, ["service_id"]),
    getCalendars({ sunday: 1 }, ["service_id"]),
  ]);
  return [...new Set([...sat, ...sun].map((i) => i.service_id))];
}

export function isLowFloor(
  trip: Trip | Partial<Trip> | null | undefined,
  vehiclesLocation: VehicleEntity,
  routeLocal: Pick<RouteDoc, "short_name">,
): boolean {
  // const is_low_floor = !!trip?.wheelchair_accessible ?? false
  // if (is_low_floor) {
  //     return true;
  // }

  const type = getRouteType(routeLocal.short_name);

  const licensePlate = vehiclesLocation.vehicle.vehicle.licensePlate;

  // Electron trolleys and maybe some LAZs
  if (type == "trolleybus") {
    const intLicensePlate = parseInt(licensePlate);
    return intLicensePlate >= 100 && intLicensePlate < 512;
  }

  // Electron trams
  if (type == "tram") {
    const intLicensePlate = parseInt(licensePlate);
    return (
      intLicensePlate >= 1218 ||
      (intLicensePlate >= 1179 && intLicensePlate <= 1187)
    );
  }

  // Electrons or MAZs
  if (
    [
      "А01",
      "А03",
      "А05",
      "А06",
      "А08",
      "А09",
      "А10",
      "А16",
      "А18",
      "А19",
      "А29",
      "А40",
      "А46",
      "А47",
      "А49",
      "А52",
      "А61",
    ].includes(routeLocal.short_name)
  ) {
    return true;
  }

  if (
    [
      "BC-4166-ET",
      "BC-4167-ET",
      "BC-4168-ET",
      "BC-4169-ET",
      "BC-7306-EP",
      "BC-7313-EP",
      "BC-7342-EP",
      "BC-7346-EP",

      "AC-8634-EM",
      "AC-4293-EM",
      "AC-4294-EM",
      "AC-8629-EM",
      "BC-0144-OC",
      "BC-0243-MC",
      "BC-0245-MC",
      "BC-1349-MC",
      "BC-1371-MC",
      "BC-8466-ME",
      "BC-8467-ME",
      "BC-8732-MI",
      "BC-8734-MI",
    ].includes(licensePlate)
  ) {
    return true;
  }

  return false;
}

/**
 * GTFS-style normalization, including the "A08a" variant suffix when present.
 * Import uses this to tell plain A08 (emergency replacement for T08) from A08a (real route).
 */
export function normalizeRouteNameBase(routeName: string): string {
  const rawNumber = parseInt(routeName.replace(/\D/g, ""));
  let prefix = "А";
  const isTramOrTrol = ["Т", "T"].some((n) => routeName.startsWith(n));
  const inNightBus = ["Н", "H"].some((n) => routeName.startsWith(n));

  if (isTramOrTrol) {
    // tram or trol
    prefix = rawNumber >= 20 ? "Тр" : "Т";
  } else if (inNightBus) {
    // night bus
    prefix = "Н-А";
  }

  let postfix = "";
  if (
    routeName.endsWith("а") ||
    routeName.endsWith("А") ||
    routeName.endsWith("a")
  ) {
    postfix = "a";
  }

  return prefix + (rawNumber >= 10 ? rawNumber : "0" + rawNumber) + postfix;
}

/** Canonical short_name for DB and API (real A08a bus is stored and shown as A08 / А08). */
export function normalizeRouteName(routeName: string): string {
  const base = normalizeRouteNameBase(routeName);
  return base === "А08a" ? "А08" : base;
}

export function routeNameToUrlFriendly(routeName: string): string {
  const normalized = normalizeRouteName(routeName);
  const prefixMap = [
    ["Тр", "T"],
    ["Т", "T"],
    ["А", "A"],
  ];

  for (const [cyrillic, latin] of prefixMap) {
    if (normalized.startsWith(cyrillic)) {
      return latin + normalized.slice(cyrillic.length);
    }
  }

  return normalized;
}

export function getRouteType(routeName: string): VehicleType {
  let type: VehicleType = "bus";
  if (routeName.startsWith("Тр")) {
    type = "trolleybus";
  } else if (routeName.startsWith("Т")) {
    type = "tram";
  }
  return type;
}

export function cleanUpStopName(stopName: string): string {
  return stopName.replace(/(\([\-\d]+\))/gi, "").trim();
}

/**
 * Canonical order of a route's shapes. A direction index is a position in this
 * list — that is the only definition of "direction" the API exposes, and both
 * shape_direction_map and trip_direction_map are built from it.
 */
export function sortedShapeIds(route: Pick<RouteDoc, "shapes">): string[] {
  return Object.keys(route.shapes ?? {}).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

export function getDirectionByTrip(
  tripId: string | null | undefined,
  routeModel: Pick<RouteDoc, "shapes" | "trip_shape_map">,
): number | null {
  if (!tripId || !routeModel.trip_shape_map[tripId]) {
    return null;
  }

  const direction = sortedShapeIds(routeModel).indexOf(
    routeModel.trip_shape_map[tripId]!,
  );
  return direction === -1 ? null : direction;
}

export function getTextWaitTime(busArrivalTime: Date | number, from: Date = new Date()): string {
  let minutesLeft = Math.round((Number(busArrivalTime) - Number(from)) / 1000 / 60);
  return (minutesLeft > 0 ? minutesLeft : "< 1") + "хв";
}

export function formatRouteName(name: string): string {
  if (name.startsWith("Тр")) {
    name = name.replace("Тр", "Т");
  } else if (name.startsWith("Н-А")) {
    name = name.replace("Н-А", "Н");
  }

  name = name.replace("-А", "");
  name = name.replace("а", "");
  name = name.replace(/a$/, "");

  return name;
}

/**
 * Most-used shape per direction over a whole week: each trip counts once for
 * every day its service runs, so a workday shape is not outvoted by a
 * weekend one, and the pick does not depend on the import's weekday.
 */
export async function getMostPopularShapes(
  routeId: string,
  serviceDays?: Record<string, number>,
): Promise<string[]> {
  const days = serviceDays ?? (await getServiceDayCounts());
  const trips = await getTrips(
    { route_id: routeId, service_id: Object.keys(days) },
    ["shape_id", "direction_id", "service_id"],
  );

  if (!trips.length) return [];

  const shapeIds = [...new Set(trips.map((t) => t.shape_id).filter(Boolean))];
  if (!shapeIds.length) return [];

  const existingShapeRaw = await getShapes({ shape_id: shapeIds }, ["shape_id"]);
  const existingShapeIds = new Set(existingShapeRaw.map((s) => s.shape_id));

  // Count trips per (direction, shape_id), then pick the most-used shape per direction
  const byDir = new Map<number, Map<string, number>>();
  for (const t of trips) {
    if (!t.shape_id || !existingShapeIds.has(t.shape_id)) continue;
    const dir = t.direction_id ?? 0;
    if (!byDir.has(dir)) byDir.set(dir, new Map());
    const m = byDir.get(dir)!;
    m.set(t.shape_id, (m.get(t.shape_id) ?? 0) + (days[t.service_id] ?? 1));
  }

  const result: string[] = [];
  for (const counts of byDir.values()) {
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    result.push(best);
  }
  return result.sort();
}

export function getRouteColor(routeName: string): string {
  switch (routeName.charAt(0)) {
    case "Т": {
      const colorMap: Record<string, string> = {
        38: "9B0A00",
        33: "6F7C32",
        32: "E51467",
        31: "229038",
        30: "EF88AA",
        29: "323C8D",
        27: "B0CB1F",
        25: "E85222",
        24: "E5E248",
        23: "BD8260",
        22: "3E9B7D",
        "09": "26602C",
        "08": "919191",
        "07": "0971B7",
        "06": "954592",
        "05": "FECD27",
        "04": "1CBBEE",
        "03": "50B056",
        "02": "93573D",
        "01": "E42D24",
      };

      // A tram/trolleybus line missing from the map used to come out as
      // "#undefined"; it falls through to the default colour instead.
      const rawNumber = (routeName.match(/\d+/g) ?? []).join("");
      if (colorMap[rawNumber]) return "#" + colorMap[rawNumber];
      break;
    }
    case "Н":
      return "#000000";
  }

  return "#0E4F95";
}

// Text drawn on a route's colour is white, except on the few lines too pale for it.
const DARK_TEXT_LINES = new Set(["24", "27", "30"]);

export function getRouteTextColor(routeName: string): string {
  const rawNumber = (routeName.match(/\d+/g) ?? []).join("");
  return routeName.charAt(0) === "Т" && DARK_TEXT_LINES.has(rawNumber) ? "#000000" : "#FFFFFF";
}

export interface ImportedTrip {
  trip_id: string;
  direction_id: number | null;
  shape_id: string | null;
}

/**
 * Every trip of a route on the given services, whatever shape it runs.
 * Feeds trip_shape_map and trip_direction_map, which realtime vehicles are
 * looked up in by trip ID: a trip missing there is a vehicle with no
 * direction.
 */
export async function getRouteTrips(routeId: string, serviceIds: string[]): Promise<ImportedTrip[]> {
  return getTrips({ route_id: routeId, service_id: serviceIds }, ["trip_id", "direction_id", "shape_id"]);
}

/**
 * Direction of each trip. A trip on one of the route's shapes takes that
 * shape's position (getDirectionByTrip). Any other trip — a short-turn or a
 * variant — gets its GTFS direction_id translated through the trips on the
 * route's shapes, since direction_id runs opposite to shape order on many
 * Lviv routes; raw direction_id only when nothing to translate it by.
 */
export function assignTripDirections(
  trips: ImportedTrip[],
  route: Pick<RouteDoc, "shapes" | "trip_shape_map">,
): Record<string, number> {
  const result: Record<string, number> = {};
  const votes = new Map<number, Map<number, number>>();
  const offShape: ImportedTrip[] = [];
  for (const t of trips) {
    const direction = getDirectionByTrip(t.trip_id, route);
    if (direction === null) {
      offShape.push(t);
      continue;
    }
    result[t.trip_id] = direction;
    if (t.direction_id == null) continue;
    if (!votes.has(t.direction_id)) votes.set(t.direction_id, new Map());
    const tally = votes.get(t.direction_id)!;
    tally.set(direction, (tally.get(direction) ?? 0) + 1);
  }
  const translate = new Map(
    [...votes].map(([gtfs, tally]) => [gtfs, [...tally].sort((a, b) => b[1] - a[1])[0][0]]),
  );
  for (const t of offShape) {
    if (t.direction_id == null) continue;
    result[t.trip_id] = translate.get(t.direction_id) ?? t.direction_id;
  }
  return result;
}

/**
 * One trip per direction to read the stop sequence from. Trips on the
 * route's own shapes only, when there are any: a short-turn variant would
 * cut the stop list short.
 */
export function getSmapleTrips(
  route: Pick<RouteDoc, "trip_direction_map"> & Partial<Pick<RouteDoc, "shapes" | "trip_shape_map">>,
): string[] {
  const entries = Object.entries(route.trip_direction_map);
  const onShape = entries.filter(([tripId]) => {
    const shape = route.trip_shape_map?.[tripId];
    return !!shape && !!route.shapes && shape in route.shapes;
  });
  let sampleTrips: string[] = [];

  for (const [key, value] of onShape.length ? onShape : entries) {
    sampleTrips[value] = key;
  }

  return sampleTrips;
}

export function shapes_by_direction(
  route: Pick<RouteDoc, "shapes" | "shape_direction_map">,
): LatLng[][] {
  let shapes: LatLng[][] = [];

  for (const key in route.shape_direction_map) {
    shapes[route.shape_direction_map[key]] = route.shapes[key];
  }

  return shapes;
}

// Contact banner shown at the top of the public HTML listings (/stops, /routes).
export const CONTACT_PHONE = "+380638628402";
export const CONTACT_TELEGRAM = "vbhjckfd";

export function contactBannerStyle(): string {
  return `.contact-banner {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px 14px; margin: 0 0 12px;
  background: #dbeafe; border-bottom: 1px solid #93c5fd;
  font: 15px/1.4 system-ui, sans-serif; color: #1e3a8a;
}
.contact-banner a { color: #1d4ed8; font-weight: bold; }
.contact-banner .chat-link {
  padding: 3px 10px; border-radius: 4px; color: #fff;
}
.contact-banner .viber { background: #7360f2; }
.contact-banner .whatsapp { background: #25d366; }
.contact-banner .telegram { background: #229ed9; }
.contact-banner .page-link {
  margin-left: auto; padding: 3px 10px;
  border: 1px solid #1d4ed8; border-radius: 4px;
}`;
}

// Cross-links between the two public listings; key is the page being rendered.
const CROSS_PAGE_LINK: Record<string, { href: string; label: string }> = {
  stops: { href: "/routes", label: "Маршрути" },
  routes: { href: "/stops", label: "Зупинки" },
};

export function contactBannerHtml(page: string): string {
  const digits = CONTACT_PHONE.replace(/\D/g, "");
  const cross = CROSS_PAGE_LINK[page];
  const crossHtml = cross
    ? `\n<a class="page-link" href="${cross.href}">${cross.label}</a>`
    : "";
  return `<div class="contact-banner">
<span>Будь-які запитання — Мирослав, <a href="tel:${CONTACT_PHONE}">${CONTACT_PHONE}</a></span>
<a class="chat-link viber" href="viber://chat?number=%2B${digits}">Viber</a>
<a class="chat-link whatsapp" target="_blank" rel="noopener" href="https://wa.me/${digits}">WhatsApp</a>
<a class="chat-link telegram" target="_blank" rel="noopener" href="https://t.me/${CONTACT_TELEGRAM}">Telegram</a>${crossHtml}
</div>`;
}
