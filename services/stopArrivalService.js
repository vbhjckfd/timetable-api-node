const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");
const microgizService = require("./microgizService");

const timetableDb = require('../connections/timetableSqliteDb');

const stopArrivalService = {

    getTimetableForStop: async function(stop) {
        const now = (new Date()).setMilliseconds(0);

        const allRoutesRaw = timetableDb.getCollection('routes').find({});

        const [closestVehiclesRaw, vehiclesLocationsRaw] = await Promise.all([
            microgizService.getArrivalTimes(),
            microgizService.getVehiclesLocations()
        ]);

        const routesByRouteId = _(allRoutesRaw).keyBy('external_id').value();

        const closestVehicles = closestVehiclesRaw
        .filter(entity => {
            return entity.tripUpdate.stopTimeUpdate.map(stu => stu.stopId).includes(stop.microgiz_id);
        })
        .map(i => i.tripUpdate)
        .map(i => {
            i.stopTimeUpdate = i.stopTimeUpdate.filter(st => st.stopId == stop.microgiz_id).shift();
            return i;
        })
        .map(i => {
            const time = i.stopTimeUpdate.arrival || i.stopTimeUpdate.departure;
            return {
                time: parseInt(`${time.time}000`),
                route_id: i.trip.routeId,
                trip_id: i.trip.tripId,
                vehicle: i.vehicle.id
            }
        })
        .filter(i => new Date(i.time) >= now)
        .sort((a, b) => a.time - b.time);

        const tripsRaw = await gtfs.getTrips({
            trip_id: closestVehicles.map(v => v.trip_id)
        });

        const trips = _(tripsRaw).keyBy('trip_id').value();

        const vehiclesIds = closestVehicles.map(v => v.vehicle)
        const vehiclesLocations = _(vehiclesLocationsRaw)
            .filter(entity => vehiclesIds.includes(entity.vehicle.vehicle.id))
            .map(i => {
                const position = i.vehicle.position;

                return {
                    vehicle_id: i.vehicle.vehicle.id,
                    location: [
                        position.latitude.toFixed(5),
                        position.longitude.toFixed(5)
                    ],
                    bearing: position.bearing
                };
            })
            .keyBy('vehicle_id')
            .value()
        ;

        result = closestVehicles.map(vh => {
            let routeInfoRaw = stop.transfers.find(i => i.id == vh.route_id);
            let routeInfo = {}
            if (routeInfoRaw) {
                routeInfo = _.omit(routeInfoRaw, ['_id', 'id'])
            } else {
                const routeObj = routesByRouteId[vh.route_id];
                if (!routeObj) {
                    return null;
                }
                console.error(`No binding for route ${appHelpers.formatRouteName(routeObj.short_name)} to stop ${stop.name} (${stop.code})`);
                routeInfo = {
                    color: appHelpers.getRouteColor(routeObj.short_name),
                    route: appHelpers.formatRouteName(routeObj.short_name),
                    vehicle_type: appHelpers.getRouteType(routeObj.short_name),
                }
            }

            return {
                route_id: vh.route_id,
                direction: appHelpers.getDirectionByTrip(vh.trip_id, routesByRouteId[vh.route_id]),
                lowfloor: !!trips[vh.trip_id]?.wheelchair_accessible ?? false,
                end_stop: appHelpers?.cleanUpStopName(trips[vh.trip_id].trip_headsign) ?? '',
                arrival_time: (new Date(vh.time)).toUTCString(),
                time_left: appHelpers.getTextWaitTime(vh.time),
                ...vehiclesLocations[vh.vehicle],
                ...routeInfo,
            }}
        );

        return result.filter(i => !!i);
    }

}

module.exports = stopArrivalService;