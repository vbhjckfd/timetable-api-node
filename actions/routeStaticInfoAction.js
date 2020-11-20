const gtfs = require('gtfs');
const _ = require('lodash');
const timetableDb = require('../connections/timetableDb');
const appHelpers = require("../utils/appHelpers");

const StopModel = timetableDb.model('Stop');
const RouteModel = timetableDb.model('Route');

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {external_id: parseInt(req.params.name)() } : {short_name: appHelpers.normalizeRouteName(req.params.name)}

    const routeLocal = await RouteModel.findOne(query)

    if (!routeLocal) return res.sendStatus(404);

    if (routeLocal.shapes.size < 2) return res.sendStatus(500);

    const allStops = _(await StopModel.find({
        code: {
            $in: Array.from(routeLocal.stops_by_shape.values()).flat()
        }
    })).keyBy('code').value();

    let stopsByShape = [];

    let shapes = routeLocal.shapes_by_direction();

    for (key of [0, 1]) {
        stopsByShape[key] = _(routeLocal.stops_by_shape.get(String(key)))
            .filter(st => !!allStops[st])
            .map(st => allStops[st])
            .map(s => {
                const transfers = s.transfers
                .map(i => {
                    const { _id, shape_id, ...omitted } = i.toObject();
                    return omitted;
                })
                .filter(i => routeLocal.external_id != i.id)
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
            id: routeLocal.external_id,
            color: appHelpers.getRouteColor(routeLocal.short_name),
            type: appHelpers.getRouteType(routeLocal.short_name),
            route_short_name: routeLocal.short_name,
            route_long_name: routeLocal.long_name,
            stops: stopsByShape,
            shapes: shapes
        })
    ;
}