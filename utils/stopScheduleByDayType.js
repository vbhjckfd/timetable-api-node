/**
 * Departure times by day type for one stop of a route. `saturday`/`sunday` fall
 * back to the combined weekend map for routes imported before the per-day split
 * existed; `weekend` is kept for older API consumers. A day map that exists
 * but lacks the stop means no service that day, not "use the fallback".
 */
export function stopScheduleByDayType(routeLocal, microgizId) {
  const pick = (map, fallback = []) =>
    map ? (map[microgizId] ?? []) : fallback;
  const weekend = pick(routeLocal.stop_departure_time_map_weekend);
  return {
    workday: pick(routeLocal.stop_departure_time_map_workday),
    saturday: pick(routeLocal.stop_departure_time_map_saturday, weekend),
    sunday: pick(routeLocal.stop_departure_time_map_sunday, weekend),
    weekend,
  };
}
