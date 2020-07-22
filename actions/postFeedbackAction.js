const timetableDb = require('../connections/timetableDb');
const FeedbackModel = timetableDb.model('Feedback');

module.exports = async (req, res, next) => {
    let dataToSave = {
        message: req.body.message,
        user_uuid: req.body.uuid,
        is_response: false,
        user_agent: req.get('User-Agent') || null
    }

    if (Array.isArray(req.body.location) && req.body.location.length == 2) {
        dataToSave.location = {
            type: "Point",
            coordinates: req.body.location || [],
        }
    }

    await FeedbackModel.create(dataToSave);

    res
        .status(201)
        .send();
}