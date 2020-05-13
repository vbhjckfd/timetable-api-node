const gtfs = require('gtfs');
const mongoose = require('mongoose');
const _ = require('lodash');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const normalizeRouteName = (routeName) => {
    let rawNumber = parseInt(routeName.replace(/\D/g,''));
    let prefix = 'А';

    if (routeName.startsWith('Т')) {
        // tram or trol
        prefix = (rawNumber >= 30) ? 'Тр' : 'Т';
        
    } else if (routeName.startsWith('Н')) {
        // night bus
        prefix = 'Н-А'
    }

    return prefix + ((rawNumber > 10) ? rawNumber : ('0' + rawNumber));
}

module.exports = async (req, res, next) => {
    mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

    const routes = await gtfs.getRoutes();

    let route = _(routes).find((i) => {
        return i.route_short_name === normalizeRouteName(req.params.name);
    });

    const response = await fetch('http://track.ua-gis.com/gtfs/lviv/vehicle_position');
    const body = await response.buffer();

    let vehicles = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body).entity
    .filter((entity) => {
        return entity.vehicle.trip.routeId == route.route_id && !!entity.vehicle.trip.tripId
    })
    .map((i) => {
        let position = i.vehicle.position;

        return {
            'location': [
                position.latitude,
                position.longitude
            ],
            'bearing': position.bearing
        };
    });    

    mongoose.connection.close();

    res
        .send(vehicles);
}