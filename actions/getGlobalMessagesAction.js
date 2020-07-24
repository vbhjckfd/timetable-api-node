const timetableDb = require('../connections/timetableDb');
const MessageModel = timetableDb.model('Message');

module.exports = async (req, res, next) => {
    let dateSince = new Date(1970, 0);
    if (req.query.since) {
        dateSince = new Date(req.query.since.replace(/"/g, ''));

        if (dateSince instanceof Date && isNaN(dateSince.getTime())) {
            console.error(`Bad input argument ${req.query.since}`);
            dateSince = new Date(1970, 0);
        }
    }

    const messagesRaw = await MessageModel.find({createdAt: {$gt: dateSince}}).sort('createdAt');

    res
        .set('Cache-Control', `private, max-age=0`)
        .send(messagesRaw.map(m => {
            return {
                date: m.createdAt,
                message: m.message
            }
        }))
}