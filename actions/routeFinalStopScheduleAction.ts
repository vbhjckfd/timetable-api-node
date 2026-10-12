import type { NextFunction, Request, Response } from "express";
import {
  normalizeRouteName,
  getRouteColor,
  getRouteType,
} from "../utils/appHelpers.ts";
import { stopScheduleByDayType } from "../utils/stopScheduleByDayType.ts";
import db from "../connections/timetableSqliteDb.ts";
import type { RouteDoc, StopDoc } from "../types/domain.ts";

export default async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  const cacheAgeSeconds = 30 * 24 * 3600;
  const query = Number(req.params.name)
    ? { external_id: req.params.name }
    : { short_name: normalizeRouteName(req.params.name) };

  const routeLocal = db.getCollection<RouteDoc>("routes").findOne(query);

  if (!routeLocal) return res.sendStatus(404);

  // `shapes` is a plain object keyed by shape_id; it has no `.size`, so the
  // old `shapes.size < 2` compared undefined and never fired.
  if (Object.keys(routeLocal.shapes ?? {}).length < 2) return res.sendStatus(500);

  const stopsArr = db.getCollection<StopDoc>("stops").find({
    code: { $in: Object.values(routeLocal.stops_by_shape).flat() },
  });
  const allStops: Record<number, StopDoc> = Object.fromEntries(stopsArr.map((s) => [s.code, s]));

  const stopsByShape = [];

  for (const key of [0, 1]) {
    const orderedStopCodes = routeLocal.stops_by_shape[String(key)].filter(
      (st) => !!allStops[st],
    );

    const mappedStops = orderedStopCodes.map((stopCode) => {
      const stop = allStops[stopCode];
      return {
        code: stop.code,
        name: stop.name,
        eng_name: stop.eng_name,
        microgiz_id: stop.microgiz_id,
        loc: [stop.location.coordinates[0], stop.location.coordinates[1]],
      };
    });

    const terminusStop = mappedStops.at(-1);
    const departures = terminusStop
      ? routeLocal.stop_departure_time_map[terminusStop.microgiz_id] ?? []
      : [];
    const schedule = terminusStop
      ? stopScheduleByDayType(routeLocal, terminusStop.microgiz_id)
      : { workday: [], saturday: [], sunday: [], weekend: [] };

    stopsByShape[key] = {
      direction: key,
      terminus: terminusStop,
      departures,
      schedule,
    };
  }

  res
    .set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${cacheAgeSeconds}`,
    )
    .set("Cache-Tag", "short")
    .json({
      id: routeLocal.external_id,
      color: getRouteColor(routeLocal.short_name),
      type: getRouteType(routeLocal.short_name),
      route_short_name: routeLocal.short_name,
      route_long_name: routeLocal.long_name,
      directions: [stopsByShape[0], stopsByShape[1]],
    });
};
