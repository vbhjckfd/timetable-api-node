const gtfs = require('gtfs');
const _ = require('lodash');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const appHelpers = require("../utils/appHelpers");

module.exports = async (req, res, next) => {
    const response = await fetch('http://track.ua-gis.com/gtfs/lviv/vehicle_position');
    const body = await response.buffer();

    let vehiclePosition = _(GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body).entity)
    .find((entity) => {
        return entity.vehicle.vehicle.id == req.params.vehicleId;
    });

    if (!vehiclePosition) return res.sendStatus(404);
    vehiclePosition = vehiclePosition.vehicle;

    const trips = await gtfs.getTrips({
        'route_id': vehiclePosition.trip.routeId
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

    res
        .set('Cache-Control', `public, s-maxage=15`)
        .send({
            'location': [
                vehiclePosition.position.latitude,
                vehiclePosition.position.longitude
            ],
            'bearing': vehiclePosition.position.bearing,
            'direction': mostPopularShapes.indexOf(tripShapeMap[vehiclePosition.trip.tripId]),
            'licensePlate': vehiclePosition.vehicle.licensePlate
        });
}