const gtfs = require('gtfs');
const _ = require('lodash');
const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');
const microgizService = require('../services/microgizService');
const appHelpers = require('../utils/appHelpers');

module.exports = async (req, res, next) => {
    let vehiclePosition = _(await microgizService.getVehiclesLocations())
    .find((entity) => {
        return entity.vehicle.vehicle.id == req.params.vehicleId;
    });

    if (!vehiclePosition) return res.sendStatus(404);
    vehiclePosition = vehiclePosition.vehicle;

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

    const tripDirectionMap = await appHelpers.getTripDirectionMap(vehiclePosition.trip.routeId);

    const stopRoutesMap = await microgizService.routesThroughStop();

    res
        .set('Cache-Control', `public, s-maxage=5`)
        .send({
            location: [
                vehiclePosition.position.latitude,
                vehiclePosition.position.longitude
            ],
            routeId: vehiclePosition.trip.routeId,
            bearing: vehiclePosition.position.bearing,
            direction: tripDirectionMap[vehiclePosition.trip.tripId],
            licensePlate: vehiclePosition.vehicle.licensePlate,
            arrivals: arrivalTimes.map((item) => {
                return {
                    code: stopIdsMap[item.stopId].code,
                    arrival: item.arrival ? (new Date(parseInt(`${item.arrival.time}000`))).toUTCString() : null,
                    departure: item.departure ? (new Date(parseInt(`${item.departure.time}000`))).toUTCString() : null,
                    transfers: stopRoutesMap[stopIdsMap[item.stopId].code]
                };
            })
        });
}