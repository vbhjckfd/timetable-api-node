const gtfs = require('gtfs');
const timetableDb = require('../connections/timetableDb');
const microgizService = require("../services/microgizService");
const appHelpers = require("../utils/appHelpers");

module.exports = async (req, res, next) => {

    const StopModel = timetableDb.model('Stop');
    const RouteModel = timetableDb.model('Route');

    const importedStops = await gtfs.getStops();
    const importedRoutes = await gtfs.getRoutes();
    let stopIds = [];

    if (!importedStops.length) {
        return res.sendStatus(500);
    }

    const routeRelatedPromises = importedRoutes.map(async r => {
        let routeModel = await RouteModel.findOne({external_id: r.route_id});

        if (!routeModel) {
            routeModel = await RouteModel.create({
                external_id: r.route_id,
                trip_shape_map: new Map(),
                most_popular_shapes: []
            });
        }

        const mostPopularShapes = await appHelpers.getMostPopularShapes(r.route_id);
        routeModel.most_popular_shapes = mostPopularShapes;
        routeModel.markModified('most_popular_shapes');

        let tripDirectionMap = {};

        const trips = await gtfs.getTrips({
            route_id: r.route_id,
            shape_id: {'$in': Array.from(mostPopularShapes)}
        }, {trip_id: 1, direction_id: 1, _id: 0});

        trips.forEach(t => {
            tripDirectionMap[t.trip_id] = t.direction_id;
        });

        let routeTripShapeMap = new Map();
        for (tripId in tripDirectionMap) {
            routeTripShapeMap.set(tripId, tripDirectionMap[tripId]);
        }

        routeModel.trip_shape_map = routeTripShapeMap;
        routeModel.markModified('trip_shape_map');

        return routeModel.save();
    });

    await Promise.all(routeRelatedPromises);

    console.log(`${routeRelatedPromises.length} routes processed`);

    const stopPromises = importedStops.map(async stopRow => {
        let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);

        if (null === code) {
            code = stopRow.stop_code
        } else if (Array.isArray(code)) {
            code = code[0]
        }

        for (cleaner of ['(', ')']) {
            code = code.replace(cleaner, '')
        }
        code = Number(code);

        if (!code) {
            console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
            return;
        }

        if ([83].includes(code)) {
            console.warn(`Manually skipped stop with code ${code}`);
            return;
        }

        if (["45002"].includes(stopRow.stop_id)) {
            console.warn(`Manually skipped stop with microgiz id ${stopRow.stop_id}`);
            return;
        }

        let stop_name = stopRow.stop_name;

        for (cleaner of [`00${code}`, `0${code}`, code, '()', '" "', '(Т6)', '(0)', 'уточнити' , /^"{1}/ , /\s+$/, "\\"]) {
            stop_name = stop_name.replace(cleaner, '')
        }
        stop_name = stop_name.replace('""', '"')

        let stopModel = await StopModel.findOne({code: code});

        const stopData = {
            code: code,
            name: stop_name,
            microgiz_id: stopRow.stop_id,
            location: {
                type: "Point",
                coordinates: stopRow.loc
            },
            transfers: [],
        };

        if (!stopModel) {
            stopModel = await StopModel.create(stopData);
            await stopModel.save();
        }

        stopModel.name = stopData.name;
        stopModel.microgiz_id = stopData.microgiz_id;
        stopModel.location = stopData.location;

        stopIds.push(stopModel.id);

        stopModel.transfers = await microgizService.routesThroughStop(stopModel);
        stopModel.markModified('transfers');
        return stopModel.save();
    });

    console.log('Firing async process of stops processing');

    await Promise.all(stopPromises);

    if (stopIds.length > 0) {
        await StopModel.deleteMany({"_id" : { $nin : stopIds}})
    }

    console.log(`${stopPromises.length} stops processed`);

    res.send('Ok');
}