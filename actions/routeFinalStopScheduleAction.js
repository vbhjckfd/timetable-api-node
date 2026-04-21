import _ from "lodash";
import {
  normalizeRouteName,
  getRouteColor,
  getRouteType,
} from "../utils/appHelpers.js";
import db from "../connections/timetableSqliteDb.js";

export default async (req, res, next) => {
  const longCacheAgeSeconds = 30 * 24 * 3600;
  const query = Number(req.params.name)
    ? { external_id: req.params.name }
    : { short_name: normalizeRouteName(req.params.name) };

  const routeLocal = db.getCollection("routes").findOne(query);

  if (!routeLocal) return res.sendStatus(404);

  if (routeLocal.shapes.size < 2) return res.sendStatus(500);

  const allStops = _(
    db.getCollection("stops").find({
      code: {
        $in: Object.values(routeLocal.stops_by_shape).flat(),
      },
    }),
  )
    .keyBy("code")
    .value();

  const stopsByShape = [];

  for (const key of [0, 1]) {
    const orderedStopCodes = _(routeLocal.stops_by_shape[String(key)])
      .filter((st) => !!allStops[st])
      .value();

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

    const terminusStop = _(mappedStops).last();
    const departures = terminusStop
      ? routeLocal.stop_departure_time_map[terminusStop.microgiz_id] ?? []
      : [];

    stopsByShape[key] = {
      direction: key,
      terminus: terminusStop,
      departures,
    };
  }

  res
    .set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${longCacheAgeSeconds}`,
    )
    .set("Cache-Tag", "long")
    .json({
      id: routeLocal.external_id,
      color: getRouteColor(routeLocal.short_name),
      type: getRouteType(routeLocal.short_name),
      route_short_name: routeLocal.short_name,
      route_long_name: routeLocal.long_name,
      directions: [stopsByShape[0], stopsByShape[1]],
    });
};
