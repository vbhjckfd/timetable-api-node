const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");
const microgizService = require("./microgizService");

const stopArrivalService = {

    getTimetableForStop: async function(stop) {
        const now = (new Date()).setMilliseconds(0);

        const [closestVehiclesRaw, vehiclesLocationsRaw, allRoutesRaw] = await Promise.all([
            microgizService.getArrivalTimes(),
            microgizService.getVehiclesLocations(),
            gtfs.getRoutes()
        ]);

        const routesByRouteId = _(allRoutesRaw).keyBy('route_id').value();

        const closestVehicles = closestVehiclesRaw
        .filter(entity => {
            return entity.tripUpdate.stopTimeUpdate.map(stu => parseInt(stu.stopId)).includes(stop.microgiz_id);
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
            trip_id: {
                $in: closestVehicles.map(v => v.trip_id)
            }
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

        return closestVehicles.map(vh => {
            let routeInfoRaw = stop.transfers.find(i => i.id == vh.route_id);
            let routeInfo = {}
            if (routeInfoRaw) {
                routeInfo = _.omit(routeInfoRaw.toObject(), ['_id', 'id'])
            } else {
                const routeObj = routesByRouteId[vh.route_id];
                console.error(`No binding for route ${appHelpers.formatRouteName(routeObj)} to stop ${stop.name} (${stop.code})`);
                routeInfo = {
                    color: appHelpers.getRouteColor(routeObj),
                    route: appHelpers.formatRouteName(routeObj),
                    vehicle_type: appHelpers.getRouteType(routeObj),
                }
            }

            return {
                direction: trips[vh.trip_id] ? trips[vh.trip_id].direction_id : null,
                lowfloor: trips[vh.trip_id] ? !!trips[vh.trip_id].wheelchair_accessible : false,
                end_stop: trips[vh.trip_id] ? appHelpers.cleanUpStopName(trips[vh.trip_id].trip_headsign) : '',
                arrival_time: (new Date(vh.time)).toUTCString(),
                time_left: appHelpers.getTextWaitTime(vh.time),
                ...vehiclesLocations[vh.vehicle],
                ...routeInfo,
            }}
        );
    }

}

module.exports = stopArrivalService;