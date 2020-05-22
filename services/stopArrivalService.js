const gtfs = require('gtfs');
const _ = require('lodash');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const appHelpers = require("../utils/appHelpers");

const stopArrivalService = {
    
    getTimetableForStop: async function(stop) {
        const response = await fetch(process.env.TRIP_UDPDATES_URL || 'http://track.ua-gis.com/gtfs/lviv/trip_updates');
        const body = await response.buffer();

        const closestVehicles = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body).entity
        .filter((entity) => {
            return entity.tripUpdate.stopTimeUpdate.map((stu) => {return parseInt(stu.stopId)}).includes(stop.microgiz_id);
        })
        .map((i) => {return i.tripUpdate})
        .map((i) => {
            i.stopTimeUpdate = i.stopTimeUpdate.filter((st) => {return st.stopId == stop.microgiz_id}).shift();
            return i;
        })
        .map((i) => {
            let arrivalTime = null;
            if (i.stopTimeUpdate.arrival) {
                arrivalTime = parseInt(`${i.stopTimeUpdate.arrival.time.low}000`);
            }

            return {
                time: arrivalTime,
                route_id: i.trip.routeId,
                trip_id: i.trip.tripId,
                vehicle: i.vehicle.id
            }
        })
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

        return closestVehicles.map((vh) => {
            return {
                route: appHelpers.formatRouteName(routes[vh.route_id]),
                vehicle_type: appHelpers.getRouteType(routes[vh.route_id]),
                lowfloor: !!trips[vh.trip_id].wheelchair_accessible,
                end_stop: appHelpers.cleanUpStopName(trips[vh.trip_id].trip_headsign),
                arrival_time: (new Date(vh.time)).toUTCString(),
                time_left: appHelpers.getTextWaitTime(vh.time),
                vehicle_id: vh.vehicle
            };
        });
    }

}

module.exports = stopArrivalService;