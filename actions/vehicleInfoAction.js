const _ = require('lodash');
const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');
const RouteModel = timetableDb.model('Route');
const microgizService = require('../services/microgizService');

module.exports = async (req, res, next) => {
    const [vehiclePositionRaw, arrivalTimeItemsRaw] = await Promise.all([
        microgizService.getVehiclesLocations(),
        microgizService.getArrivalTimes()
    ]);

    let vehiclePosition = _(vehiclePositionRaw)
        .find(entity => entity.vehicle.vehicle.id == req.params.vehicleId)
    ;

    if (!vehiclePosition) return res.sendStatus(404);
    vehiclePosition = vehiclePosition.vehicle;

    const arrivalTimeItems = _(arrivalTimeItemsRaw)
        .filter(entity => entity.tripUpdate.vehicle.id == req.params.vehicleId)
        .value()
    ;

    let arrivalTimes = [];
    if (arrivalTimeItems) {
        arrivalTimeItems.forEach(i => {arrivalTimes = arrivalTimes.concat(i.tripUpdate.stopTimeUpdate)});
    }

    const stopIds = arrivalTimes.map(i => i.stopId);

    const stopIdsMap = _(await StopModel.find({
        microgiz_id: {
            $in: stopIds
        }
    }))
    .keyBy('microgiz_id')
    .value();

    arrivalTimes = arrivalTimes.filter(item => !!stopIdsMap[item.stopId])

    const routeLocal = await RouteModel.findOne({external_id: vehiclePosition.trip.routeId});

    res
        .set('Cache-Control', `public, s-maxage=5`)
        .send({
            location: [
                vehiclePosition.position.latitude,
                vehiclePosition.position.longitude
            ],
            routeId: vehiclePosition.trip.routeId,
            bearing: vehiclePosition.position.bearing,
            direction: routeLocal.trip_shape_map.get(vehiclePosition.trip.tripId.toString()),
            licensePlate: vehiclePosition.vehicle.licensePlate,
            arrivals: arrivalTimes.map((item) => {
                const transfers = stopIdsMap[item.stopId].transfers
                .map(i => {
                    const { _id, ...omitted } = i.toObject();
                    return omitted;
                })
                .filter(i => vehiclePosition.trip.routeId != i.id)
                .sort((a, b) => {
                    if (a['vehicle_type'] == b['vehicle_type']) {
                        return 0;
                    }

                    return a['vehicle_type'] == 'bus' ? 1 : -1;
                })
                ;

                return {
                    code: stopIdsMap[item.stopId].code,
                    arrival: item.arrival ? (new Date(parseInt(`${item.arrival.time}000`))).toUTCString() : null,
                    departure: item.departure ? (new Date(parseInt(`${item.departure.time}000`))).toUTCString() : null,
                    transfers: transfers
                };
            })
        });
}