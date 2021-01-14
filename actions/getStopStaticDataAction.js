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

    const transfers = stop.transfers.map(i => {
        const { _id, ...omitted } = i;
        return omitted;
    });

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${10 * 24 * 3600}`)
        .json({
            name: stop.name,
            longitude: stop.location.coordinates[1],
            latitude: stop.location.coordinates[0],
            code: stop.code,
            transfers: transfers,
        })
    ;
}