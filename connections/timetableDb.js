const mongoose = require('mongoose');
const feedbackSchema = require('./../schemas/feedback');
const messageSchema = require('./../schemas/message');

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

module.exports = timetableDb;