const gtfs = require('gtfs');
const _ = require('lodash');
const microgizService = require('../services/microgizService');
const appHelpers = require("../utils/appHelpers");

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {route_id: parseInt(req.params.name).toString() } : {route_short_name: appHelpers.normalizeRouteName(req.params.name)}

    const route = (await gtfs.getRoutes(query)).shift();

    if (!route) return res.sendStatus(404);

    const tripDirectionMap = await appHelpers.getTripDirectionMap(route.route_id);
    const goodTripIds = Object.keys(tripDirectionMap);

    let vehicles = _(await microgizService.getVehiclesLocations())
    .filter((entity) => {
        return entity.vehicle.trip.routeId == route.route_id && !!entity.vehicle.trip.tripId && goodTripIds.includes(entity.vehicle.trip.tripId)
    })
    .map((i) => {
        let position = i.vehicle.position;

        return {
            'id': i.vehicle.vehicle.id,
            'direction': tripDirectionMap[i.vehicle.trip.tripId],
            'location': [
                position.latitude,
                position.longitude
            ],
            'bearing': position.bearing
        };
    });

    res
        .set('Cache-Control', `public, s-maxage=10`)
        .send(vehicles);
}