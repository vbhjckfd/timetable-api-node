const mongoose = require('mongoose');
const stopSchema = require('./../schemas/stop');
const feedbackSchema = require('./../schemas/feedback');

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const timetableDb = mongoose.createConnection(process.env.MONGO_URL, dbConfig)
timetableDb.model('Stop', stopSchema);
timetableDb.model('Feedback', feedbackSchema);

module.exports = timetableDb;