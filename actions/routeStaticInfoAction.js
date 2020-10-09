const gtfs = require('gtfs');
const _ = require('lodash');
const timetableDb = require('../connections/timetableDb');
const appHelpers = require("../utils/appHelpers");

const StopModel = timetableDb.model('Stop');
const RouteModel = timetableDb.model('Route');

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {route_id: parseInt(req.params.name).toString() } : {route_short_name: appHelpers.normalizeRouteName(req.params.name)}

    const route = (await gtfs.getRoutes(query)).shift();

    if (!route) return res.sendStatus(404);

    const routeLocal = await RouteModel.findOne({external_id: route.route_id})
    let mostPopularShapes = new Set();

    const trips = await gtfs.getTrips({
        'trip_id': {$in : Array.from(routeLocal.trip_shape_map.keys())}
    });

    let tripShapeMap = {};
    trips.forEach((t) => {
        tripShapeMap[t.shape_id] = t.trip_id;
        mostPopularShapes.add(t.shape_id);
    });

    const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();

    mostPopularShapes = Array.from(mostPopularShapes);

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
            .filter(data => data.trip_id == tripShapeMap[mostPopularShapes[key]])
            .filter(st => !!allStops[st.stop_id])
            .map(st => allStops[st.stop_id])
            .map(s => {
                const transfers = s.transfers
                .map(i => {
                    const { _id, shape_id, ...omitted } = i.toObject();
                    return omitted;
                })
                .filter(i => route.route_id != i.id)
                .sort((a, b) => {
                    if (a['vehicle_type'] == b['vehicle_type']) {
                        return 0;
                    }

                    return a['vehicle_type'] == 'bus' ? 1 : -1;
                })
                ;

                return {
                    code: s.code,
                    name: s.name,
                    loc: [s.location.coordinates[1], s.location.coordinates[0]],
                    transfers: transfers,
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
            type: appHelpers.getRouteType(route),
            route_short_name: route.route_short_name,
            route_long_name: route.route_long_name,
            stops: stopsByShape,
            shapes: _(shapes).map((s) => { return s.map((point) => {
                return [point.shape_pt_lat, point.shape_pt_lon]
            }) }).value()
        })
    ;
}