import _ from 'lodash';
import { getVehiclesLocations } from '../services/microgizService.js';
import { normalizeRouteName, isLowFloor, getTodayServiceIds } from "../utils/appHelpers.js";
import db from '../connections/timetableSqliteDb.js';
import { getTrips } from 'gtfs';

export default async (req, res, next) => {
    const query = Number(req.params.name) ? {external_id: req.params.name } : {short_name: normalizeRouteName(req.params.name)};

    const routeLocal = db.getCollection('routes').findOne(query);

    if (!routeLocal) return res.sendStatus(404);

    const tripDirectionMap = routeLocal.trip_direction_map;

    const vehicles = _(await getVehiclesLocations())
    .filter(entity => {
        return entity.vehicle.trip.routeId == routeLocal.external_id && !!entity.vehicle.trip.tripId;
    });
    // .filter(e => tripDirectionMap.hasOwnProperty(e.vehicle.trip.tripId.toString()))

    const tripsRaw = await getTrips({
        trip_id: vehicles.map(v => v.vehicle.trip.tripId).filter(n => n).value(),
        service_id: await getTodayServiceIds(),
    });
    const trips = _(tripsRaw).keyBy('trip_id').value();

    const result = vehicles.map(i => {
        const position = i.vehicle.position;

        return {
            id: i.vehicle.vehicle.id,
            direction: tripDirectionMap[i.vehicle.trip.tripId.toString()],
            location: [
                position.latitude,
                position.longitude
            ],
            bearing: position.bearing,
            lowfloor: isLowFloor(trips[i.vehicle.trip.tripId], i, routeLocal),
        };
    });

    res
        .set('Cache-Control', `public, s-maxage=10`)
        .send(result);
}