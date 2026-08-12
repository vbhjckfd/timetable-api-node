import { cleanUpStopName, getTextWaitTime } from "../utils/appHelpers.js";

// How far ahead of "now" a scheduled departure may be and still be worth
// showing. Long enough to cover the outer stops of the network, where headways
// run 30 min and more, short enough that the list stays a list of what is
// coming rather than a printed timetable.
const SCHEDULE_WINDOW_MINUTES = 90;

// Per route+direction, so a 5-minute-headway trunk route cannot crowd out the
// half-hourly one a rider is actually waiting for.
const MAX_ENTRIES_PER_ROUTE = 2;

const MAX_ENTRIES = 8;

// Departure maps are keyed by stop and hold "HH:MM" strings in local (Kyiv)
// time. The service day here never crosses midnight — the latest departure in
// the data is 23:59 — so a plain same-day parse is enough.
function parseLocalTime(hhmm, reference) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const at = new Date(reference);
  at.setHours(hours, minutes, 0, 0);
  return at;
}

// The import writes three maps: a combined one plus workday/weekend splits.
// Prefer the split that matches the day being asked about; the combined map is
// the fallback for routes imported before the split existed.
function departuresForStop(route, microgizId, isWeekend) {
  const preferred = isWeekend
    ? route.stop_departure_time_map_weekend
    : route.stop_departure_time_map_workday;

  return (
    preferred?.[microgizId] ??
    route.stop_departure_time_map?.[microgizId] ??
    []
  );
}

/**
 * Upcoming *scheduled* departures at a stop, in the same shape as the live
 * arrivals from stopArrivalService.
 *
 * The live feed only predicts a bounded number of stops ahead of each vehicle
 * (gtfs-eta caps a trip at its next 10 stops), so a stop far along its routes
 * routinely has no live prediction at all even mid-service — measured at
 * Рясне-1 (code 694), which went blank for 30-60 s at a time on a weekday
 * evening while six routes were running. To a rider that is indistinguishable
 * from "nothing is coming tonight". These entries fill that gap: they carry no
 * vehicle and are flagged `scheduled: true` so a consumer can render them as
 * timetable data rather than as a tracked vehicle.
 */
export function getScheduledArrivalsForStop(
  stop,
  routesByRouteId,
  { now = new Date(), windowMinutes = SCHEDULE_WINDOW_MINUTES, limit = MAX_ENTRIES } = {},
) {
  if (!stop?.microgiz_id || !Array.isArray(stop.transfers)) return [];

  const isWeekend = [0, 6].includes(now.getDay());
  const until = new Date(now.getTime() + windowMinutes * 60 * 1000);

  const entries = [];

  for (const transfer of stop.transfers) {
    const route = routesByRouteId[transfer.id];
    if (!route) continue;

    const { _id, id, ...routeInfo } = transfer;

    const upcoming = departuresForStop(route, stop.microgiz_id, isWeekend)
      .map((hhmm) => parseLocalTime(hhmm, now))
      .filter((at) => at && at > now && at <= until)
      .sort((a, b) => a - b)
      .slice(0, MAX_ENTRIES_PER_ROUTE);

    for (const at of upcoming) {
      entries.push({
        route_id: id,
        lowfloor: false,
        end_stop: transfer.end_stop_name
          ? cleanUpStopName(transfer.end_stop_name)
          : "",
        arrival_time: at.toUTCString(),
        time_left: getTextWaitTime(at, now),
        scheduled: true,
        ...routeInfo,
      });
    }
  }

  return entries
    .sort((a, b) => new Date(a.arrival_time) - new Date(b.arrival_time))
    .slice(0, limit);
}

export default { getScheduledArrivalsForStop };
