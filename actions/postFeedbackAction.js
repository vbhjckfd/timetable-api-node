const timetableDb = require('../connections/timetableDb');
const FeedbackModel = timetableDb.model('Feedback');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res, next) => {
    const feedbackData = {
        message: req.body.message,
        user_uuid: req.body.uuid,
        uuid: uuidv4(),
        response: null,
    };

    const feedback = await FeedbackModel.create(feedbackData);

    res
        .set('Location', `/feedback/${feedback.uuid}`)
        .status(201)
        .send({
            id: feedback.uuid
        });
}