const _ = require('lodash');
const microgizService = require('../services/microgizService');
const appHelpers = require("../utils/appHelpers");
const geodist = require('geodist');
const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    const latitude = parseFloat(req.query.latitude).toFixed(3),
          longitude = parseFloat(req.query.longitude).toFixed(3)
    ;

    const vehiclesRaw = await microgizService.getVehiclesLocations();

    const routes = _(timetableDb.getCollection('routes').find({}))
    .keyBy('external_id')
    .value();

    const vehicles = _(vehiclesRaw)
    .filter(i => !!routes[i.vehicle.trip.routeId])
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
            color: appHelpers.getRouteColor(route.short_name),
            route: appHelpers.formatRouteName(route.short_name),
            vehicle_type: appHelpers.getRouteType(route.short_name),
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