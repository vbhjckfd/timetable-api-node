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

    const trips = await gtfs.getTrips({
        trip_id: {$in : Array.from(routeLocal.trip_shape_map.keys())}
    }, { shape_id: 1, trip_id: 1, _id: 0 });

    let tripShapeMap = {};
    trips.forEach(t => {
        tripShapeMap[t.shape_id] = t.trip_id;
    });

    const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();

    const mostPopularShapes = routeLocal.most_popular_shapes;

    const shapesRaw = await gtfs.getShapes({
        shape_id: {
            $in: mostPopularShapes
        }
    }, {shape_id: 1, shape_pt_lat: 1, shape_pt_lon: 1, _id: 0});

    if (shapesRaw.length < 2) return res.sendStatus(500);

    // Basically shapesRaw[0] is same as shapesRaw[1], mixed but identical. Stupid google adapter
    const shapeRawFixed = shapesRaw[0];

    const stopTimes = await gtfs.getStoptimes({
        agency_key: 'Microgiz',
        trip_id: {
            $in: _(tripShapeMap).values().value()
        }
    }, {trip_id: 1, stop_id: 1, _id: 0});

    let stopsByShape = [];
    let shapes = [];

    for (key of [0, 1]) {
        stopsByShape[key] = _(stopTimes)
            .filter(data => routeLocal.trip_shape_map.get(data.trip_id) == key)
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

        shapes[key] = shapeRawFixed.filter(shapeItem => routeLocal.trip_shape_map.get(tripShapeMap[shapeItem.shape_id]) == key);
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
            shapes: shapes.map(s => s.map(p => [p.shape_pt_lat, p.shape_pt_lon]))
        })
    ;
}