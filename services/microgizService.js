const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");

//let Promise = require('bluebird');
//const redisClient = Promise.promisifyAll(require("./redisClient"));

// const ARRIVALS_CACHE_KEY = 'arrival-times';
// const LOCATION_CACHE_KEY = 'vehicles-locations';

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
                        // redisClient.setex(LOCATION_CACHE_KEY, 10, JSON.stringify(parsedData));

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
                        // redisClient.setex(ARRIVALS_CACHE_KEY, 10, JSON.stringify(parsedData));
    
                        return parsedData;
                    });
        // });
    }

};