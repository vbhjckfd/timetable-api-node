const timetableDb = require('../connections/timetableDb');
const FeedbackModel = timetableDb.model('Feedback');

module.exports = async (req, res, next) => {
    const feedbackData = {
        message: req.body.message,
    };

    const feedback = await FeedbackModel.create(feedbackData);

    res
        .send({message: `Ваше звернення зареєстровано під номером ${feedback._id}`});
}