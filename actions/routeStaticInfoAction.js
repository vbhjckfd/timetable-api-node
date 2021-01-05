const _ = require('lodash');
const appHelpers = require("../utils/appHelpers");
const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    const query = Number(req.params.name) ? {external_id: parseInt(req.params.name)() } : {short_name: appHelpers.normalizeRouteName(req.params.name)}

    const routeLocal = timetableDb.getCollection('routes').findOne(query);

    if (!routeLocal) return res.sendStatus(404);

    if (routeLocal.shapes.size < 2) return res.sendStatus(500);

    const allStops = _(timetableDb.getCollection('stops').find({
        code: {
            $in: Object.values(routeLocal.stops_by_shape).flat()
        }
    })).keyBy('code').value();

    let stopsByShape = [];

    let shapes = appHelpers.shapes_by_direction(routeLocal);

    for (key of [0, 1]) {
        stopsByShape[key] = _(routeLocal.stops_by_shape[String(key)])
            .filter(st => !!allStops[st])
            .map(st => allStops[st])
            .map(s => {
                const transfers = s.transfers
                .map(i => {
                    const { _id, shape_id, ...omitted } = i;
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