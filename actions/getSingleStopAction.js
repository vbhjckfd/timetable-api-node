import stopArrivalService from '../services/stopArrivalService.js';
import db from '../connections/timetableSqliteDb.js';

export default async (req, res, next) => {
    const code = Number(req.params.code);
    if (!code)  {
        res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
        return;
    }

    const stop = db.getCollection('stops').findOne({code: code})

    if (!stop) {
        res.status(404).send(`Bad argument, stop with code ${code} not found`);
        return;
    }

    const skipTimetableData = req.query.skipTimetableData || false;
    let timetableData = [];
    try {
        if (!skipTimetableData) {
            timetableData = await stopArrivalService.getTimetableForStop(stop);
        }
    } catch (e) {
        console.error(e);
    }
    const cacheAge = timetableData.length > 0 ? 10 : 5;

    const transfers = stop.transfers.map(i => {
        const { _id, ...omitted } = i;
        return omitted;
    });

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${skipTimetableData ? 10 * 24 * 3600 : cacheAge}`)
        .json({
            name: stop.name,
            eng_name: stop.eng_name,
            longitude: stop.location.coordinates[1],
            latitude: stop.location.coordinates[0],
            transfers: transfers,
            code: stop.code,
            timetable: timetableData
        })
    ;
}