const timetableService = require('../services/stopArrivalService');
const timetableDb = require('../connections/timetableSqliteDb');

module.exports = async (req, res, next) => {
    const code = Number(req.params.code);
    if (!code)  {
        res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
        return;
    }

    const stop = timetableDb.getCollection('stops').findOne({code: code})
    if (!stop) {
        res.status(404).send(`Bad argument, stop with code ${code} not found`);
        return;
    }

    let timetableData = [];
    try {
        timetableData = await timetableService.getTimetableForStop(stop);

        timetableData = timetableData.map(i => {
            const { direction, shape_id, ...rest } = i;
            return rest;
        })
    } catch (e) {
        console.error(e);
    }
    const cacheAge = timetableData.length > 0 ? 10 : 5;

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${cacheAge}`)
        .json(timetableData)
    ;
}