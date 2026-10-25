import db from "../connections/timetableSqliteDb.ts";
import { departuresForStop } from "./stopScheduleService.ts";
import type { RouteDoc, StopDoc } from "../types/domain.ts";

/**
 * Timetable arithmetic for trip planning: when to leave, which departure to
 * catch, when you arrive, and how often a route runs.
 *
 * The imported timetable keeps departure times per route and stop, not per
 * trip (stop_times are dropped from the runtime DB), so a ride's duration is
 * not read off one trip but estimated from the two stops' departure lists.
 * Every time here is a Lviv wall-clock minute of the day.
 */

const TIME_ZONE = "Europe/Kyiv";

/** Walking pace for the walks at either end and between platforms. */
export const WALK_METERS_PER_MINUTE = 80;

/** Ride time per stop when the departure lists do not line up. */
const FALLBACK_MINUTES_PER_STOP = 2;

/** A ride estimate longer than this per stop means the lists were mismatched. */
const MAX_MINUTES_PER_STOP = 6;

/** Departures this far either side of now count towards the scheduled headway. */
const HEADWAY_WINDOW_MINUTES = 45;

const routes = () => db.getCollection<RouteDoc>("routes");
const stops = () => db.getCollection<StopDoc>("stops");

export interface KyivClock {
  weekday: number;
  /** Minutes since local midnight, fractional. */
  minutes: number;
}

export function kyivClock(at: Date): KyivClock {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 };
}

/** The instant the local clock reads `minutes` on the same day as `reference`. */
export function atMinutes(reference: Date, minutes: number): Date {
  return new Date(reference.getTime() + (minutes - kyivClock(reference).minutes) * 60_000);
}

export const hhmm = (minutes: number): string => {
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/**
 * "HH:MM" as Lviv time today, or any ISO 8601 timestamp. Null for anything
 * else, so a caller can reject it with a message.
 */
export function parseTripTime(value: string, now: Date = new Date()): Date | null {
  const local = toMinutes(value.trim());
  if (local != null) return local < 24 * 60 ? atMinutes(now, local) : null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function departureMinutes(route: RouteDoc, stopCode: number, weekday: number): number[] {
  const stop = stops().findOne({ code: stopCode });
  if (!stop?.microgiz_id) return [];
  return departuresForStop(route, stop.microgiz_id, weekday)
    .map(toMinutes)
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Minutes from boarding to alighting. When every trip calls at both stops the
 * k-th departure at one is the k-th at the other, and the median offset is the
 * ride; otherwise the first trips of the day are paired; failing both, a
 * per-stop average.
 */
export function rideMinutes(board: number[], alight: number[], stopsCount: number): number {
  const plausible = (m: number) => m > 0 && m <= stopsCount * MAX_MINUTES_PER_STOP;
  if (board.length && board.length === alight.length) {
    const paired = median(board.map((b, i) => alight[i] - b));
    if (plausible(paired)) return paired;
  }
  if (board.length && alight.length && plausible(alight[0] - board[0])) return alight[0] - board[0];
  return stopsCount * FALLBACK_MINUTES_PER_STOP;
}

export interface ScheduleLeg {
  route_id: string;
  board_code: number;
  alight_code: number;
  stops_count: number;
}

export interface TripWalks {
  to_board_meters: number;
  /** One per interchange: legs.length - 1 entries. */
  transfer_meters: number[];
  from_alight_meters: number;
}

export interface LegTimes {
  board_at: string;
  alight_at: string;
}

export interface TripSchedule {
  leave_at: string;
  arrive_at: string;
  total_minutes: number;
  legs: LegTimes[];
}

const walkMinutes = (meters: number): number => Math.ceil(meters / WALK_METERS_PER_MINUTE);

/**
 * When to leave, which departure each leg catches and when the trip ends, by
 * the timetable for that day. `depart_at` catches the first departures after
 * it; `arrive_by` the last ones that still arrive in time. Null when the day's
 * service does not cover the trip (after the last departure, or a route
 * without a timetable for that stop).
 */
export function scheduleTrip(
  legs: ScheduleLeg[],
  walks: TripWalks,
  when: { depart_at: Date } | { arrive_by: Date },
): TripSchedule | null {
  const reference = "depart_at" in when ? when.depart_at : when.arrive_by;
  const { weekday, minutes } = kyivClock(reference);

  const timed = legs.map((leg) => {
    const route = routes().findOne({ external_id: leg.route_id });
    if (!route) return null;
    const board = departureMinutes(route, leg.board_code, weekday);
    const ride = rideMinutes(board, departureMinutes(route, leg.alight_code, weekday), leg.stops_count);
    return { board, ride };
  });
  if (timed.some((t) => !t || !t.board.length)) return null;
  const legTimes = timed as { board: number[]; ride: number }[];

  const walksBefore = [walks.to_board_meters, ...walks.transfer_meters].map(walkMinutes);
  const walkAfter = walkMinutes(walks.from_alight_meters);
  const result: { board: number; alight: number }[] = [];

  if ("depart_at" in when) {
    let ready = minutes;
    for (const [i, { board, ride }] of legTimes.entries()) {
      ready += walksBefore[i];
      const catchAt = board.find((b) => b >= ready);
      if (catchAt == null) return null;
      result.push({ board: catchAt, alight: catchAt + ride });
      ready = catchAt + ride;
    }
  } else {
    let latest = minutes - walkAfter;
    for (let i = legTimes.length - 1; i >= 0; i--) {
      const { board, ride } = legTimes[i];
      const catchAt = board.findLast((b) => b + ride <= latest);
      if (catchAt == null) return null;
      result.unshift({ board: catchAt, alight: catchAt + ride });
      latest = catchAt - walksBefore[i];
    }
  }

  const leave = "depart_at" in when ? minutes : result[0].board - walksBefore[0];
  const arrive = result.at(-1)!.alight + walkAfter;
  return {
    leave_at: hhmm(leave),
    arrive_at: hhmm(arrive),
    total_minutes: Math.round(arrive - leave),
    legs: result.map(({ board, alight }) => ({ board_at: hhmm(board), alight_at: hhmm(alight) })),
  };
}

/**
 * Typical minutes between departures of one direction right now, from its
 * first stop's timetable for today. Null outside service hours or with fewer
 * than two departures in the window.
 */
export function scheduledHeadway(routeId: string, direction: number, now: Date = new Date()): number | null {
  const route = routes().findOne({ external_id: routeId });
  const firstStop = route?.stops_by_shape?.[String(direction)]?.[0];
  if (!route || firstStop == null) return null;
  const { weekday, minutes } = kyivClock(now);
  const near = departureMinutes(route, firstStop, weekday).filter(
    (m) => Math.abs(m - minutes) <= HEADWAY_WINDOW_MINUTES,
  );
  if (near.length < 2) return null;
  return Math.round(median(near.slice(1).map((m, i) => m - near[i])));
}
