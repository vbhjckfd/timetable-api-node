const gtfs = require('gtfs');
const _ = require('lodash');
const microgizService = require('../services/microgizService');
const appHelpers = require("../utils/appHelpers");
const geodist = require('geodist');

module.exports = async (req, res, next) => {
    const latitude = parseFloat(req.query.latitude).toFixed(3),
          longitude = parseFloat(req.query.longitude).toFixed(3)
    ;

    const [routesRaw, vehiclesRaw] = await Promise.all([
        gtfs.getRoutes(),
        microgizService.getVehiclesLocations()
    ]);

    const routes = _(routesRaw)
    .keyBy('route_id')
    .value();

    const vehicles = _(vehiclesRaw)
    .filter(i => {
        const position = i.vehicle.position;

        const dist = geodist(
            {lat: position.latitude, lon: position.longitude},
            {lat: latitude, lon: longitude},
            {unit: 'meters'}
        );

        return dist < 1000;
    })
    .map(i => {
        const position = i.vehicle.position;
        const route = routes[i.vehicle.trip.routeId];

        return {
            id: i.vehicle.vehicle.id,
            color: appHelpers.getRouteColor(route),
            route: appHelpers.formatRouteName(route),
            vehicle_type: appHelpers.getRouteType(route),
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