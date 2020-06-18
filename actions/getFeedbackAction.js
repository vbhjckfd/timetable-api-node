const timetableDb = require('../connections/timetableDb');
const FeedbackModel = timetableDb.model('Feedback');

module.exports = async (req, res, next) => {
    const id = req.params.id;
    if (!id)  {
        res.status(400).send(`No id of feedback provided`);
        return;
    }

    const feedback = await FeedbackModel.findOne({uuid: id});
    if (!feedback) {
        res.status(404).send(`No such feedback item`);
        return;
    }

    res
        .set('Cache-Control', `private, max-age=0`)
        .send({
            response: feedback.response || null
        })
}