import timetableDb from '../connections/timetableDb.js';
const FeedbackModel = timetableDb.model('Feedback');

export default async (req, res, next) => {
    const id = req.params.id;
    if (!id)  {
        res.status(400).send(`No id of user provided`);
        return;
    }

    const chatItemsRaw = await FeedbackModel.find({user_uuid: id}).sort('createdAt');

    const chatItems = chatItemsRaw.map(i => {
        return {
            message: i.message,
            date: i.createdAt,
            is_response: i.is_response || false
        }
    });

    res
        .set('Cache-Control', `private, max-age=0`)
        .send(chatItems)
}