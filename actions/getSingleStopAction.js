const timetableService = require('../services/stopArrivalService');
const timetableDb = require('../connections/timetableDb');

const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    let code = Number(req.params.code);
    if (!code)  {
        res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
        return;
    }

    let stop = await StopModel.findOne({code: code});
    if (!stop) {
        res.status(404).send(`Bad argument, stop with code ${code} not found`);
        return;
    }

    let timetableData = await timetableService.getTimetableForStop(stop);

    res
        .set('Cache-Control', `public, s-maxage=60`)
        .json({
            name: stop.name,
            longitude: stop.location.coordinates[0],
            latitude: stop.location.coordinates[1],
            code: stop.code,
            timetable: timetableData
        })
    ;
}