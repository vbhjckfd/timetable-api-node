const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");

const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

let Promise = require('bluebird');
//const redisClient = Promise.promisifyAll(require("./redisClient"));

const ARRIVALS_CACHE_KEY = 'arrival-times';
const LOCATION_CACHE_KEY = 'vehicles-locations';
const STOP_ROUTE_MAP_KEY = 'stop-route-map-hash';

module.exports = {

    getVehiclesLocations: () => {
        // return redisClient.getAsync(LOCATION_CACHE_KEY)
        //     .then((data) => {
        //         if (data) {
        //             return JSON.parse(data);
        //         }

                return fetch(process.env.VEHICLES_LOCATION_URL || 'http://track.ua-gis.com/gtfs/lviv/vehicle_position')
                    .then(response => response.buffer())
                    .then(data => {
                        const parsedData = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity;
                        //redisClient.setex(LOCATION_CACHE_KEY, 10, JSON.stringify(parsedData));

                        return parsedData;
                    });
        // });
    },

    getArrivalTimes: () => {
        // return redisClient.getAsync(ARRIVALS_CACHE_KEY)
        //     .then((data) => {
        //         if (data) {
        //             return JSON.parse(data);
        //         }

                return fetch(process.env.TRIP_UDPDATES_URL || 'http://track.ua-gis.com/gtfs/lviv/trip_updates')
                    .then(response => response.buffer())
                    .then(data => {
                        const parsedData = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity;
                        //redisClient.setex(ARRIVALS_CACHE_KEY, 10, JSON.stringify(parsedData));

                        return parsedData;
                    });
        // });
    },

    routesThroughStop: async (stopIds) => {
        // return redisClient.getAsync(STOP_ROUTE_MAP_KEY)
        //     .then(async (data) => {
        //         if (data) {
        //             console.log('HIT!');
        //             return JSON.parse(data);
        //         }

                let stopRoutesMap = {};
                for (let stopId of stopIds) {
                    stopRoutesMap[stopId] = [];
                }
                return stopRoutesMap;

                const stopTimes = await gtfs.getStoptimes({
                    agency_key: 'Microgiz',
                    stop_id: {
                        $in: stopIds
                    }
                });

                const trips = await gtfs.getTrips({
                    trip_id: {
                        $in: stopTimes.map(st => {return st.trip_id})
                    }
                });
                const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();
                const allRoutes = _(await gtfs.getRoutes({})).keyBy('route_id').value();

                let tripsPerRoute = {};
                trips.forEach(t => {
                    tripsPerRoute[t.route_id] = tripsPerRoute[t.route_id] || [];

                    tripsPerRoute[t.route_id].push(t);
                });



                for (let routeId in tripsPerRoute) {
                    let tripShapeMap = {};
                    let shapeIdsStat = [];
                    tripsPerRoute[routeId].forEach((t) => {
                        tripShapeMap[t.shape_id] = t.trip_id;
                        shapeIdsStat.push(t.shape_id);
                    });

                    const mostPopularShapes = _(shapeIdsStat)
                        .countBy()
                        .entries()
                        .orderBy(_.last)
                        .takeRight(1)
                        .map(_.head)
                        .sort()
                        .value()
                    ;

                    if (!mostPopularShapes[0]) {
                        continue;
                    }

                    stopTimes
                    .filter(st => {
                        return tripShapeMap[mostPopularShapes[0]] == st.trip_id;
                    })
                    .forEach(st => {
                        allStops[st.stop_id] && stopRoutesMap[st.stop_id].push({
                            color: '#' + appHelpers.getRouteColor(allRoutes[routeId]),
                            route: appHelpers.formatRouteName(allRoutes[routeId]),
                            vehicle_type: appHelpers.getRouteType(allRoutes[routeId]),
                        });
                    });
                }

                // redisClient.setex(ARRIVALS_CACHE_KEY, 3600, JSON.stringify(stopRoutesMap));
                return stopRoutesMap;
        // });



    }

};