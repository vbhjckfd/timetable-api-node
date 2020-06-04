const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const gtfs = require('gtfs');
const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");

const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

let Promise = require('bluebird');
const redisClient = Promise.promisifyAll(require("./redisClient"));

const ARRIVALS_CACHE_KEY = 'arrival-times';
const LOCATION_CACHE_KEY = 'vehicles-locations';
const STOP_ROUTE_MAP_KEY = 'stop-route-map-hash';

module.exports = {

    getVehiclesLocations: () => {
        return redisClient.getAsync(LOCATION_CACHE_KEY)
            .then((data) => {
                if (data) {
                    return JSON.parse(data);
                }

                return fetch(process.env.VEHICLES_LOCATION_URL || 'http://track.ua-gis.com/gtfs/lviv/vehicle_position')
                    .then(response => response.buffer())
                    .then(data => {
                        const parsedData = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity;
                        redisClient.setex(LOCATION_CACHE_KEY, 10, JSON.stringify(parsedData));

                        return parsedData;
                    });
        });
    },

    getArrivalTimes: () => {
        return redisClient.getAsync(ARRIVALS_CACHE_KEY)
            .then((data) => {
                if (data) {
                    return JSON.parse(data);
                }

                return fetch(process.env.TRIP_UDPDATES_URL || 'http://track.ua-gis.com/gtfs/lviv/trip_updates')
                    .then(response => response.buffer())
                    .then(data => {
                        const parsedData = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity;
                        redisClient.setex(ARRIVALS_CACHE_KEY, 10, JSON.stringify(parsedData));

                        return parsedData;
                    });
        });
    },

    routesThroughStop: async (stopIds) => {
        return redisClient.getAsync(STOP_ROUTE_MAP_KEY)
            .then(async (data) => {
                if (data) {
                    console.log('HIT!');
                    return JSON.parse(data);
                }

                const trips = await gtfs.getTrips();
                const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();
                const allRoutes = _(await gtfs.getRoutes({})).keyBy('route_id').value();

                let tripsPerRoute = {};
                trips.forEach(t => {
                    tripsPerRoute[t.route_id] = tripsPerRoute[t.route_id] || [];

                    tripsPerRoute[t.route_id].push(t);
                });

                let stopRoutesMap = {};
                Object.keys(allStops).forEach(key => {
                    stopRoutesMap[allStops[key].code] = [];
                })

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
                        .takeRight(2)
                        .map(_.head)
                        .sort()
                        .value()
                    ;

                    if (!(mostPopularShapes[0] && mostPopularShapes[1])) {
                        continue;
                    }

                    const stopTimes = await gtfs.getStoptimes({
                        agency_key: 'Microgiz',
                        trip_id: {
                            $in: [
                                tripShapeMap[mostPopularShapes[0]],
                                tripShapeMap[mostPopularShapes[1]]
                            ]
                        }
                    });

                    stopTimes.forEach(st => {
                        allStops[st.stop_id] && stopRoutesMap[allStops[st.stop_id].code].push({
                            color: '#' + appHelpers.getRouteColor(allRoutes[routeId]),
                            route: appHelpers.formatRouteName(allRoutes[routeId]),
                            vehicle_type: appHelpers.getRouteType(allRoutes[routeId]),
                        });
                    });
                }

                redisClient.setex(ARRIVALS_CACHE_KEY, 3600, JSON.stringify(stopRoutesMap));
                return stopRoutesMap;
        });



    }

};