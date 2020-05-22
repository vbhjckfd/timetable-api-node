const timetableService = require('../services/stopArrivalService');
const timetableDb = require('../connections/timetableDb');

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

    let timetableData = [];
    try {
        timetableData = await timetableService.getTimetableForStop(stop);
    } catch (e) {
        console.error(e);
    }
    const cacheAge = timetableData.length > 0 ? 30 : 10;

    res
        .set('Cache-Control', `public, s-maxage=${cacheAge}`)
        .json({
            name: stop.name,
            longitude: stop.location.coordinates[0],
            latitude: stop.location.coordinates[1],
            code: stop.code,
            timetable: timetableData
        })
    ;
}