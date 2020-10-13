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

    const transfers = stop.transfers.map(i => {
        const { _id, ...omitted } = i.toObject();
        return omitted;
    });

    res
        .set('Cache-Control', `public, max-age=0, s-maxage=${10 * 24 * 3600}`)
        .json({
            name: stop.name,
            longitude: stop.location.coordinates[0],
            latitude: stop.location.coordinates[1],
            code: stop.code,
            transfers: transfers,
        })
    ;
}