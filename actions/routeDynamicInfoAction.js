const gtfs = require('gtfs');
const _ = require('lodash');
const microgizService = require('../services/microgizService');
const fetch = require("node-fetch");
const appHelpers = require("../utils/appHelpers");

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {route_id: parseInt(req.params.name).toString() } : {route_short_name: appHelpers.normalizeRouteName(req.params.name)}

    const route = (await gtfs.getRoutes(query)).shift();

    if (!route) return res.sendStatus(404);

    let trips = await gtfs.getTrips({
        'route_id': route.route_id
    });

    let tripShapeMap = {};
    let shapeIdsStat = [];
    trips.forEach((t) => {
        tripShapeMap[t.trip_id] = t.shape_id;
        shapeIdsStat.push(t.shape_id);
    });

    let mostPopularShapes = _(shapeIdsStat)
        .countBy()
        .entries()
        .orderBy(_.last)
        .takeRight(2)
        .map(_.head)
        .value();

    let goodTripIds = _(trips)
        .filter((t) => {return mostPopularShapes.includes(t.shape_id)})
        .map((t) => {return t.trip_id})
        .uniq()
        .value()
    ;

    let vehicles = _(await microgizService.getVehiclesLocations())
    .filter((entity) => {
        return entity.vehicle.trip.routeId == route.route_id && !!entity.vehicle.trip.tripId && goodTripIds.includes(entity.vehicle.trip.tripId)
    })
    .map((i) => {
        let position = i.vehicle.position;

        return {
            'id': i.vehicle.vehicle.id,
            'direction': mostPopularShapes.indexOf(tripShapeMap[i.vehicle.trip.tripId]),
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