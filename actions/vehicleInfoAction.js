const gtfs = require('gtfs');
const _ = require('lodash');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');
const microgizService = require('../services/microgizService');

module.exports = async (req, res, next) => {
    let vehiclePosition = _(await microgizService.getVehiclesLocations())
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

    const arrivalTimeItems = _(await microgizService.getArrivalTimes())
    .find((entity) => {
        return entity.tripUpdate.vehicle.id == req.params.vehicleId;
    }) || null;

    let arrivalTimes = arrivalTimeItems ? arrivalTimeItems.tripUpdate.stopTimeUpdate : []

    const stopIds = arrivalTimes.map((i) => {return i.stopId});

    const stopIdsMap = _(await StopModel.find({
        microgiz_id: {
            $in: stopIds
        }
    }))
    .keyBy('microgiz_id')
    .value();

    arrivalTimes = arrivalTimes.filter((item) => {return !!stopIdsMap[item.stopId]})

    res
        .set('Cache-Control', `public, s-maxage=5`)
        .send({
            location: [
                vehiclePosition.position.latitude,
                vehiclePosition.position.longitude
            ],
            routeId: vehiclePosition.trip.routeId,
            bearing: vehiclePosition.position.bearing,
            direction: mostPopularShapes.indexOf(tripShapeMap[vehiclePosition.trip.tripId]),
            licensePlate: vehiclePosition.vehicle.licensePlate,
            arrivals: arrivalTimes.map((item) => {
                return {
                    code: stopIdsMap[item.stopId].code,
                    arrival: item.arrival ? (new Date(parseInt(`${item.arrival.time}000`))).toUTCString() : null,
                    departure: item.departure ? (new Date(parseInt(`${item.departure.time}000`))).toUTCString() : null
                };
            })
        });
}