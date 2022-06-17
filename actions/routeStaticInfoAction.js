import _ from 'lodash';
import { normalizeRouteName, shapes_by_direction, secondsUntilImportDone, getRouteColor, getRouteType } from "../utils/appHelpers.js";
import db from '../connections/timetableSqliteDb.js';

export default async (req, res, next) => {
    const query = Number(req.params.name) ? {external_id: req.params.name } : {short_name: normalizeRouteName(req.params.name)}

    const routeLocal = db.getCollection('routes').findOne(query);

    if (!routeLocal) return res.sendStatus(404);

    if (routeLocal.shapes.size < 2) return res.sendStatus(500);

    const allStops = _(db.getCollection('stops').find({
        code: {
            $in: Object.values(routeLocal.stops_by_shape).flat()
        }
    })).keyBy('code').value();

    let stopsByShape = [];

    let shapes = shapes_by_direction(routeLocal);

    for (const key of [0, 1]) {
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
                    loc: [s.location.coordinates[0], s.location.coordinates[1]],
                    transfers: transfers,
                }
            })
            .value();
    }

    //if (shapes.some((i) => {return !i.length})) return res.sendStatus(500);

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${secondsUntilImportDone()}, stale-while-revalidate=15`)
        .send({
            id: routeLocal.external_id,
            color: getRouteColor(routeLocal.short_name),
            type: getRouteType(routeLocal.short_name),
            route_short_name: routeLocal.short_name,
            route_long_name: routeLocal.long_name,
            stops: stopsByShape,
            shapes: shapes
        })
    ;
}