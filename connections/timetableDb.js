import mongoose from 'mongoose';
import feedbackSchema from './../schemas/feedback.js';
import messageSchema from './../schemas/message.js';

const dbConfig = {
    user: process.env.MONGO_LOCAL_USER,
    pass: process.env.MONGO_LOCAL_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const timetableDb = mongoose.createConnection(process.env.MONGO_URL, dbConfig)
timetableDb.model('Feedback', feedbackSchema);
timetableDb.model('Message', messageSchema);

export default timetableDb;