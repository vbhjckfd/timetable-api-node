const timetableService = require('../services/stopArrivalService');
const timetableDb = require('../connections/timetableDb');

const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    let stop = await StopModel.findOne({code: req.params.code});
    if (!stop) {
        res.sendStatus(404);
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