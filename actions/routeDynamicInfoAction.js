const gtfs = require('gtfs');
const mongoose = require('mongoose');
const _ = require('lodash');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fetch = require("node-fetch");
const normalizeRouteName = require("../utils/routeNameNormalizer");

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

module.exports = async (req, res, next) => {
    mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

    const route = (await gtfs.getRoutes({
        route_short_name: normalizeRouteName(req.params.name)
    })).shift();

    const response = await fetch('http://track.ua-gis.com/gtfs/lviv/vehicle_position');
    const body = await response.buffer();

    let trips = await gtfs.getTrips({
        'route_id': route.route_id
    });

    let tripShapeMap = {};
    let shapeIdsStat = [];
    trips.forEach((t) => {
        tripShapeMap[t.trip_id] = t.shape_id;
        shapeIdsStat.push(t.shape_id);
    });

    let mostPopularShapes = _(shapeIdsStat)
        .countBy()
        .entries()
        .orderBy(_.last)
        .takeRight(2)
        .map(_.head)
        .value();

    let goodTripIds = _(trips)
        .filter((t) => {return mostPopularShapes.includes(t.shape_id)})
        .map((t) => {return t.trip_id})
        .uniq()
        .value()
    ;

    let vehicles = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(body).entity
    .filter((entity) => {
        return entity.vehicle.trip.routeId == route.route_id && !!entity.vehicle.trip.tripId && goodTripIds.includes(entity.vehicle.trip.tripId)
    })
    .map((i) => {
        let position = i.vehicle.position;

        return {
            'id': i.vehicle.vehicle.id,
            'direction': mostPopularShapes.indexOf(tripShapeMap[i.vehicle.trip.tripId]),
            'location': [
                position.latitude,
                position.longitude
            ],
            'bearing': position.bearing
        };
    });    

    mongoose.connection.close();

    res
        .set('Cache-Control', `public, s-maxage=15`)
        .send(vehicles);
}