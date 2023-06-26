import { getTrips } from 'gtfs';
import _ from 'lodash';
import { formatRouteName, getRouteColor, getRouteType, getDirectionByTrip, cleanUpStopName, getTextWaitTime, isLowFloor, getTodayServiceIds } from "../utils/appHelpers.js";
import { getArrivalTimes, getVehiclesLocations } from "./microgizService.js";

import timetableDb from '../connections/timetableSqliteDb.js';

const stopArrivalService = {

    getTimetableForStop: async function(stop) {
        const now = new Date();

        const allRoutesRaw = timetableDb.getCollection('routes').find({});

        const [closestVehiclesRaw, vehiclesLocationsRaw] = await Promise.all([
            getArrivalTimes(),
            getVehiclesLocations()
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

        const tripsRaw = await getTrips({
            trip_id: closestVehicles.map(v => v.trip_id),
            service_id: await getTodayServiceIds(),
        });

        const trips = _(tripsRaw).keyBy('trip_id').value();

        const vehiclesIds = closestVehicles.map(v => v.vehicle)
        const vehiclesLocations = _(vehiclesLocationsRaw)
            .filter(entity => vehiclesIds.includes(entity.vehicle.vehicle.id))
            .value()
        ;

        const result = closestVehicles.map(vh => {
            let routeInfoRaw = stop.transfers.find(i => i.id == vh.route_id);
            let routeInfo = {}
            if (routeInfoRaw) {
                routeInfo = _.omit(routeInfoRaw, ['_id', 'id'])
            } else {
                const routeObj = routesByRouteId[vh.route_id];
                if (!routeObj) {
                    return null;
                }
                console.error(`No binding for route ${formatRouteName(routeObj.short_name)} to stop ${stop.name} (${stop.code})`);
                routeInfo = {
                    color: getRouteColor(routeObj.short_name),
                    route: formatRouteName(routeObj.short_name),
                    vehicle_type: getRouteType(routeObj.short_name),
                }
            }

            const vehicleLocation = _.find(vehiclesLocations, entity => entity.vehicle.vehicle.id == vh.vehicle)
            const position = vehicleLocation.vehicle.position;
            const vehicleInfo = {
                vehicle_id: vehicleLocation.vehicle.vehicle.id,
                location: [
                    position.latitude.toFixed(5),
                    position.longitude.toFixed(5)
                ],
                bearing: position.bearing
            };

            return {
                route_id: vh.route_id,
                direction: getDirectionByTrip(vh.trip_id, routesByRouteId[vh.route_id]),
                lowfloor: isLowFloor(trips[vh.trip_id], vehicleLocation, routesByRouteId[vh.route_id]),
                end_stop: cleanUpStopName(trips[vh.trip_id].trip_headsign) ?? '',
                arrival_time: (new Date(vh.time)).toUTCString(),
                time_left: getTextWaitTime(vh.time),
                ...vehicleInfo,
                ...routeInfo,
            }}
        );

        return result.filter(i => !!i);
    }

}

export default stopArrivalService;