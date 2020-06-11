const timetableService = require('../services/stopArrivalService');
const timetableDb = require('../connections/timetableDb');
const microgizService = require('../services/microgizService');
const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    const code = Number(req.params.code);
    if (!code)  {
        res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
        return;
    }

    const stop = await StopModel.findOne({code: code});
    if (!stop) {
        res.status(404).send(`Bad argument, stop with code ${code} not found`);
        return;
    }

    let timetableData, transfers = [];
    try {
        [timetableData, stopRoutesMap] = await Promise.all([
            timetableService.getTimetableForStop(stop),
            microgizService.routesThroughStop([stop.microgiz_id])
        ]);

        transfers = stopRoutesMap[stop.microgiz_id];
    } catch (e) {
        console.error(e);
    }
    const cacheAge = timetableData.length > 0 ? 10 : 5;

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${cacheAge}`)
        .json({
            name: stop.name,
            longitude: stop.location.coordinates[0],
            latitude: stop.location.coordinates[1],
            transfers: transfers,
            code: stop.code,
            timetable: timetableData
        })
    ;
}