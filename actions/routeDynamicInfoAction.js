const _ = require('lodash');
const microgizService = require('../services/microgizService');
const appHelpers = require("../utils/appHelpers");
const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {external_id: req.params.name } : {short_name: appHelpers.normalizeRouteName(req.params.name)};

    const routeLocal = timetableDb.getCollection('routes').findOne(query);

    if (!routeLocal) return res.sendStatus(404);

    const tripDirectionMap = routeLocal.trip_direction_map;

    const vehicles = _(await microgizService.getVehiclesLocations())
    .filter(entity => {
        return entity.vehicle.trip.routeId == routeLocal.external_id && !!entity.vehicle.trip.tripId;
    })
    // .filter(e => tripDirectionMap.hasOwnProperty(e.vehicle.trip.tripId.toString()))
    .map(i => {
        const position = i.vehicle.position;

        return {
            id: i.vehicle.vehicle.id,
            direction: tripDirectionMap[i.vehicle.trip.tripId.toString()],
            location: [
                position.latitude,
                position.longitude
            ],
            bearing: position.bearing
        };
    });

    res
        .set('Cache-Control', `public, s-maxage=10`)
        .send(vehicles);
}