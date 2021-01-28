const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");

let Promise = require('bluebird');

module.exports = {

    getTimeOfLastStaticUpdate: () => {
        return fetch('http://track.ua-gis.com/gtfs/lviv/static.zip', {
            method: 'HEAD'
        }).then(response => {
            return new Date(response.headers.get('last-modified'));
        })
    },

    getVehiclesLocations: () => {
        return fetch(process.env.VEHICLES_LOCATION_URL || 'http://track.ua-gis.com/gtfs/lviv/vehicle_position')
            .then(response => response.buffer())
            .then(data => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity)
            .catch(err => {
                console.error(err);
                return module.exports.getVehiclesLocations();
            });
    },

    getArrivalTimes: () => {
        return fetch(process.env.TRIP_UDPDATES_URL || 'http://track.ua-gis.com/gtfs/lviv/trip_updates')
            .then(response => response.buffer())
            .then(data => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity)
            .catch(err => {
                console.error(err);
                return module.exports.getArrivalTimes();
            });
    },

    routesThroughStop: async (stop, routesCollection, stopsCollection) => {
        const transfers = routesCollection
        .find({})
        .filter(r => {
            for (key of ["0", "1"]) {
                if (-1 !== r.stops_by_shape[key].slice(0, -1).indexOf(stop.code)) {
                    return true;
                }
            }

            return false;
        })
        .map(r => {
            const directionId = _(r.stops_by_shape).findKey(i => -1 !== i.slice(0, -1).indexOf(stop.code));
            const lastStopCode = _(r.stops_by_shape[directionId]).last();
            const shapeId = _(r.shape_direction_map).findKey(d => d == directionId);

            return {
                id: r.external_id,
                color: appHelpers.getRouteColor(r.short_name),
                route: appHelpers.formatRouteName(r.short_name),
                vehicle_type: appHelpers.getRouteType(r.short_name),
                shape_id: shapeId,
                direction_id: Number(directionId),
                end_stop_name: stopsCollection.findOne({code: lastStopCode}).name,
            };
        })
        .sort((a, b) => {
            if (a.route < b.route) {
                return -1;
            }
            if (a.route > b.route) {
                return 1;
            }

            return 0;
        });

        return transfers;
    }

};