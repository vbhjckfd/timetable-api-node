const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");
const microgizService = require("./microgizService");

const stopArrivalService = {
    
    getTimetableForStop: async function(stop) {
        const now = new Date();
        now.setMilliseconds(0);

        const closestVehicles = (await microgizService.getArrivalTimes())
        .filter((entity) => {
            return entity.tripUpdate.stopTimeUpdate.map((stu) => {return parseInt(stu.stopId)}).includes(stop.microgiz_id);
        })
        .map((i) => {return i.tripUpdate})
        .map((i) => {
            i.stopTimeUpdate = i.stopTimeUpdate.filter((st) => {return st.stopId == stop.microgiz_id}).shift();
            return i;
        })
        .map((i) => {
            const time = i.stopTimeUpdate.arrival || i.stopTimeUpdate.departure;
            return {
                time: parseInt(`${time.time}000`),
                route_id: i.trip.routeId,
                trip_id: i.trip.tripId,
                vehicle: i.vehicle.id
            }
        })
        .filter(i => {return new Date(i.time) >= now;})
        .sort((a, b) => {
            return a.time - b.time;
        });

        const trips = _(await gtfs.getTrips({
            trip_id: {
                $in: closestVehicles.map((v) => {return v.trip_id})
            }
        }))
        .keyBy('trip_id')
        .value();

        const routes = _(await gtfs.getRoutes({
            route_id: {
                $in: closestVehicles.map((v) => {return v.route_id})
            }
        }))
        .keyBy('route_id')
        .value();

        const vehiclesIds = closestVehicles.map((v) => {return v.vehicle})
        const vehiclesLocations = _(await microgizService.getVehiclesLocations())
            .filter((entity) => {
                return vehiclesIds.includes(entity.vehicle.vehicle.id)
            })
            .map((i) => {
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

        return closestVehicles.map((vh) => {
            return {
                route: appHelpers.formatRouteName(routes[vh.route_id]),
                vehicle_type: appHelpers.getRouteType(routes[vh.route_id]),
                lowfloor: !!trips[vh.trip_id].wheelchair_accessible,
                end_stop: appHelpers.cleanUpStopName(trips[vh.trip_id].trip_headsign),
                arrival_time: (new Date(vh.time)).toUTCString(),
                time_left: appHelpers.getTextWaitTime(vh.time),
                ...vehiclesLocations[vh.vehicle]
            };
        });
    }

}

module.exports = stopArrivalService;