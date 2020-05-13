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

    let tripIds = [];
    let vehicles = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body).entity
    .filter((entity) => {
        return entity.vehicle.trip.routeId == route.route_id && !!entity.vehicle.trip.tripId
    })
    .map((i) => {
        let position = i.vehicle.position;
        tripIds.push(i.vehicle.trip.tripId);

        return {
            'location': [
                position.latitude,
                position.longitude
            ],
            'bearing': position.bearing
        };
    });
    tripIds = [...new Set(tripIds)];

    let shapeIdsStat = [];

    const trips = await gtfs.getTrips({
        'trip_id': {
            '$in': tripIds
        }
    });
    
    trips.forEach((t) => {
        shapeIdsStat.push(t.shape_id);
    });

    let mostPopularShapes = _(shapeIdsStat)
        .countBy()
        .entries()
        .orderBy(_.last)
        .takeRight(2)
        .map(_.head)
        .value();    

    const shapes = await gtfs.getShapes({
        'shape_id': {
            '$in': mostPopularShapes
        }
    });

    mongoose.connection.close();

    res.send({
        'color': '#' + route.route_color,
        'text_color': '#' + route.route_text_color,
        'vehicles': vehicles,
        'shapes': _(shapes).map((s) => { return s.map((point) => {
            return [point.shape_pt_lat, point.shape_pt_lon]
        }) }).value()
    });
}