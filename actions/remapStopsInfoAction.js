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

    let tripDirectionPromises = [];
    for (route of importedRoutes) {
        tripDirectionPromises.push(
            appHelpers.getTripDirectionMap(route.route_id)
                .then(async data => {
                    const any_trip_id = data.keys().next().value;
                    const trip = (await gtfs.getTrips({
                        'trip_id': any_trip_id
                    })).shift();

                    let routeModel = await RouteModel.findOne({external_id: trip.route_id});

                    if (!routeModel) {
                        routeModel = await RouteModel.create({
                            external_id: route.route_id,
                            trip_shape_map: new Map()
                        });
                    }

                    routeModel.trip_shape_map = data;
                    routeModel.markModified('trip_shape_map');

                    await routeModel.save();
                })
                .catch(error => {
                    console.error(error);
                })
        );
    }
    await Promise.all(tripDirectionPromises);
    console.log(`${tripDirectionPromises.length} routes processed`);

    let saveCallbacks = [];
    for (stopRow of importedStops) {
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
            continue;
        }

        if ([83].includes(code)) {
            console.warn(`Manually skipped stop with code ${code}`);
            continue;
        }

        if (["45002"].includes(stopRow.stop_id)) {
            console.warn(`Manually skipped stop with microgiz id ${stopRow.stop_id}`);
            continue;
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
        }

        stopModel.name = stopData.name;
        stopModel.microgiz_id = stopData.microgiz_id;
        stopModel.location = stopData.location;

        saveCallbacks.push(stopModel.save()
            .then(async (stopObj) => {
                stopObj.transfers = await microgizService.routesThroughStop(stopObj);
                stopObj.markModified('transfers');
                await stopObj.save();
            }).catch(error => {
                console.error(error, code);
            }));

        stopIds.push(stopModel.id);
    }

    if (stopIds.length > 0) {
        console.log(`${stopIds.length} stops processed, waiting for transfers callbacks`);
        await StopModel.deleteMany({"_id" : { $nin : stopIds}})
    }

    await Promise.all(saveCallbacks);
    console.log(`${saveCallbacks.length} callbacks completed`);

    res.send('Ok');
}