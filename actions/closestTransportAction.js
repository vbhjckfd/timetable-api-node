import { getVehiclesLocations } from "../services/microgizService.js";
import {
  getRouteColor,
  formatRouteName,
  getRouteType,
  isLowFloor,
  getTodayServiceIds,
  distanceMeters,
} from "../utils/appHelpers.js";
import db from "../connections/timetableSqliteDb.js";
import { getTrips } from "gtfs";

export default async (req, res, next) => {
  const latitude = parseFloat(req.query.latitude);
  const longitude = parseFloat(req.query.longitude);

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

  const routes = Object.fromEntries(
    db.getCollection("routes").find({}).map((r) => [r.external_id, r]),
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
  const trips = Object.fromEntries(tripsRaw.map((t) => [t.trip_id, t]));

  const result = vehicles.map((i) => {
    const position = i.vehicle.position;
    const route = routes[i.vehicle.trip.routeId];

    return {
      id: i.vehicle.vehicle.id,
      color: getRouteColor(route.short_name),
      route: formatRouteName(route.short_name),
      vehicle_type: getRouteType(route.short_name),
      location: [position.latitude, position.longitude],
      bearing: position.bearing,
      lowfloor: isLowFloor(trips[i.vehicle.trip.tripId], i, route),
    };
  });

  res.set("Cache-Control", `public, s-maxage=10`).send(result);
};
