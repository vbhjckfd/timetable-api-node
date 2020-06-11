const gtfs = require('gtfs');
const mongoose = require('mongoose');
const _ = require('lodash');
const timetableDb = require('../connections/timetableDb');
const appHelpers = require("../utils/appHelpers");

const StopModel = timetableDb.model('Stop');

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

module.exports = async (req, res, next) => {
    mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

    const query = Number(req.params.name) ? {route_id: parseInt(req.params.name).toString() } : {route_short_name: appHelpers.normalizeRouteName(req.params.name)}

    const route = (await gtfs.getRoutes(query)).shift();

    if (!route) return res.sendStatus(404);

    let shapeIdsStat = [];

    const trips = await gtfs.getTrips({
        'route_id': route.route_id
    });

    let tripShapeMap = {};
    trips.forEach((t) => {
        tripShapeMap[t.shape_id] = t.trip_id;
        shapeIdsStat.push(t.shape_id);
    });

    const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();

    let mostPopularShapes = _(shapeIdsStat)
        .countBy()
        .entries()
        .orderBy(_.last)
        .takeRight(2)
        .map(_.head)
        .sort()
        .value();

    let shapes = await gtfs.getShapes({
        'shape_id': {
            '$in': mostPopularShapes
        }
    });

    if (shapes.length < 2) return res.sendStatus(500);

    const stopTimes = await gtfs.getStoptimes({
        agency_key: 'Microgiz',
        trip_id: {
            $in: _(tripShapeMap).values().value()
        }
    });

    let stopsByShape = [];

    for (key in mostPopularShapes) {
        shapes[key] = _(shapes[key]).filter((data) => data.shape_id == mostPopularShapes[key]).value();
        stopsByShape[key] = _(stopTimes)
            .filter((data) => data.trip_id == tripShapeMap[mostPopularShapes[key]])
            .filter((st) => !!allStops[st.stop_id])
            .map((st) => {return allStops[st.stop_id]})
            .map((s) => {
                return {
                    code: s.code,
                    name: s.name,
                    loc: [s.location.coordinates[1], s.location.coordinates[0]]
                }
            })
            .value();
    }

    //if (shapes.some((i) => {return !i.length})) return res.sendStatus(500);

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${appHelpers.secondsUntilImportDone()}, stale-while-revalidate=15`)
        .send({
            id: route.route_id,
            color: appHelpers.getRouteColor(route),
            route_short_name: route.route_short_name,
            route_long_name: route.route_long_name,
            stops: stopsByShape,
            shapes: _(shapes).map((s) => { return s.map((point) => {
                return [point.shape_pt_lat, point.shape_pt_lon]
            }) }).value()
        })
    ;
}