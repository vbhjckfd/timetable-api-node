import type { NextFunction, Request, Response } from "express";
import { getVehiclesLocations } from "../services/microgizService.ts";
import {
  getRouteColor,
  getRouteTextColor,
  formatRouteName,
  getRouteType,
  isLowFloor,
  getTodayServiceIds,
  distanceMeters,
} from "../utils/appHelpers.ts";
import db from "../connections/timetableSqliteDb.ts";
import { getTrips } from "gtfs";
import type { Trip } from "gtfs";
import type { RouteDoc } from "../types/domain.ts";

export default async (req: Request, res: Response, next: NextFunction) => {
  const latitude = parseFloat(req.query.latitude as string);
  const longitude = parseFloat(req.query.longitude as string);

  if (
    !isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    res
      .status(400)
      .send(
        "Bad argument: latitude must be between -90 and 90, longitude between -180 and 180",
      );
    return;
  }
  const vehiclesRaw = await getVehiclesLocations();

  const routes: Record<string, RouteDoc> = Object.fromEntries(
    db.getCollection<RouteDoc>("routes").find({}).map((r) => [r.external_id, r]),
  );

  const vehicles = vehiclesRaw
    .filter((i) => !!routes[i.vehicle.trip.routeId])
    .filter((i) => {
      const position = i.vehicle.position;
      return distanceMeters(position.latitude, position.longitude, latitude, longitude) < 1000;
    });

  const tripsRaw = await getTrips({
    trip_id: vehicles.map((v) => v.vehicle.trip.tripId).filter((n) => n),
    service_id: await getTodayServiceIds(),
  });
  const trips: Record<string, Trip> = Object.fromEntries(tripsRaw.map((t) => [t.trip_id, t]));

  const result = vehicles.map((i) => {
    const position = i.vehicle.position;
    const route = routes[i.vehicle.trip.routeId];

    return {
      id: i.vehicle.vehicle.id,
      color: getRouteColor(route.short_name),
      text_color: getRouteTextColor(route.short_name),
      route: formatRouteName(route.short_name),
      vehicle_type: getRouteType(route.short_name),
      routeId: String(i.vehicle.trip.routeId),
      direction: route.trip_direction_map?.[String(i.vehicle.trip.tripId)] ?? null,
      location: [position.latitude, position.longitude],
      bearing: position.bearing,
      speed: position.speed ?? null,
      lowfloor: isLowFloor(trips[i.vehicle.trip.tripId], i, route),
    };
  });

  res.set("Cache-Control", `public, s-maxage=5`).set("Cache-Tag", "short").send(result);
};
