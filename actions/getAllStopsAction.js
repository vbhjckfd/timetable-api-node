const timetableDb = require('../connections/timetableDb');
const StopModel = timetableDb.model('Stop');

module.exports = async (req, res, next) => {
    const stopsRaw = await StopModel.find();
    res
        .set('Cache-Control', `public, max-age=0, s-maxage=3600`)
        .json(stopsRaw.map(s => {
            return {
                code: s.code
            }
        }))
    ;
}