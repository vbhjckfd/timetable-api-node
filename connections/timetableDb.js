const mongoose = require('mongoose');
const stopSchema = require('./../schemas/stop');
const feedbackSchema = require('./../schemas/feedback');
const messageSchema = require('./../schemas/message');
const routeSchema = require('./../schemas/route');

const dbConfig = {
    user: process.env.MONGO_LOCAL_USER,
    pass: process.env.MONGO_LOCAL_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const timetableDb = mongoose.createConnection(process.env.MONGO_URL, dbConfig)
timetableDb.model('Stop', stopSchema);
timetableDb.model('Feedback', feedbackSchema);
timetableDb.model('Message', messageSchema);
timetableDb.model('Route', routeSchema);

module.exports = timetableDb;