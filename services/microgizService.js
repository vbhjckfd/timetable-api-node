const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");
const timetableDb = require('../connections/timetableDb');

let Promise = require('bluebird');

const RouteModel = timetableDb.model('Route');

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

    routesThroughStop: async (stop) => {
        let routes = new Map();

        const stopTimes = await gtfs.getStoptimes({
            agency_key: 'Microgiz',
            stop_id: stop.microgiz_id,
            trip_id: {
                $gt: 0
            }
        }, {trip_id: 1, _id: 0});

        const [trips, allRoutesRaw] = await Promise.all([
            gtfs.getTrips({
                trip_id: {$in: stopTimes.map(i => i.trip_id)},
            }, {route_id: 1, shape_id: 1, trip_id: 1, direction_id: 1, _id: 0}),
            gtfs.getRoutes({})
        ])

        const allRoutes = _(allRoutesRaw).keyBy('route_id').value();

        const localRoutesRaw = await RouteModel.find();
        const locaRoutesByExternalId = _(localRoutesRaw).keyBy('external_id').value();

        let routeShapeMap = {};
        trips
        .filter(t => !!t.shape_id)
        .forEach(t => {
            if (routeShapeMap[t.route_id]) {
                return;
            }

            if (locaRoutesByExternalId[t.route_id].trip_direction_map.has(t.trip_id)) {
                routeShapeMap[t.route_id] = t;
            }
        });

        for (let routeId in routeShapeMap) {
            const mostPopularShape = routeShapeMap[routeId].shape_id

            if (!mostPopularShape) continue;

            const routeName = appHelpers.formatRouteName(allRoutes[routeId].route_short_name);
            routes.set(routeName, {
                id: routeId,
                color: appHelpers.getRouteColor(allRoutes[routeId].route_short_name),
                route: routeName,
                vehicle_type: appHelpers.getRouteType(allRoutes[routeId].route_short_name),
                shape_id: mostPopularShape,
                direction_id: routeShapeMap[routeId].direction_id
            });
        }

        routes = Array.from(routes.values()).sort((a, b) => {
            if (a.route < b.route) {
                return -1;
            }
            if (a.route > b.route) {
                return 1;
            }

            return 0;
        });

        return routes;
    }

};