import type { NextFunction, Request, Response } from "express";
import {
  normalizeRouteName,
  shapes_by_direction,
  getRouteColor,
  getRouteTextColor,
  getRouteType,
} from "../utils/appHelpers.ts";
import { stopScheduleByDayType } from "../utils/stopScheduleByDayType.ts";
import type { ScheduleByDayType } from "../utils/stopScheduleByDayType.ts";
import db from "../connections/timetableSqliteDb.ts";
import type { RouteDoc, StopDoc } from "../types/domain.ts";

export default async (req: Request<{ name: string }>, res: Response, next: NextFunction) => {
  const cacheAgeSeconds = 30 * 24 * 3600;
  const query = Number(req.params.name)
    ? { external_id: req.params.name }
    : { short_name: normalizeRouteName(req.params.name) };

  const routeLocal = db.getCollection<RouteDoc>("routes").findOne(query);

  if (!routeLocal) return res.sendStatus(404);

  const stopsArr = db.getCollection<StopDoc>("stops").find({
    code: { $in: Object.values(routeLocal.stops_by_shape).flat() },
  });
  const allStops: Record<number, StopDoc> = Object.fromEntries(stopsArr.map((s) => [s.code, s]));

  let stopsByShape = [];

  let shapes = shapes_by_direction(routeLocal);

  for (const key of [0, 1]) {
    stopsByShape[key] = routeLocal.stops_by_shape[String(key)]
      .filter((st) => !!allStops[st])
      .map((st) => allStops[st])
      .map((s, index) => {
        const transfers = s.transfers
          .map((i) => {
            const { _id, shape_id, ...omitted } = i;
            return omitted;
          })
          .filter((i) => routeLocal.external_id != i.id)
          .sort((a, b) => {
            if (a["vehicle_type"] == b["vehicle_type"]) {
              return 0;
            }

            return a["vehicle_type"] == "bus" ? 1 : -1;
          });
        let departures: string[] = [];
        let schedule: ScheduleByDayType = { workday: [], saturday: [], sunday: [], weekend: [] };
        if (0 == index) {
          departures = routeLocal.stop_departure_time_map[s.microgiz_id] ?? [];
          schedule = stopScheduleByDayType(routeLocal, s.microgiz_id);
        }

        return {
          code: s.code,
          name: s.name,
          loc: [s.location.coordinates[0], s.location.coordinates[1]],
          transfers: transfers,
          departures: departures,
          schedule,
        };
      });
  }

  //if (shapes.some((i) => {return !i.length})) return res.sendStatus(500);

  res
    .set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${cacheAgeSeconds}`,
    )
    .set("Cache-Tag", "short")
    .send({
      id: routeLocal.external_id,
      color: getRouteColor(routeLocal.short_name),
      text_color: getRouteTextColor(routeLocal.short_name),
      type: getRouteType(routeLocal.short_name),
      route_short_name: routeLocal.short_name,
      route_long_name: routeLocal.long_name,
      stops: stopsByShape,
      shapes: shapes,
    });
};
