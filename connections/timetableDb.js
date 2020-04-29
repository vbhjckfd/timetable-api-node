const mongoose = require('mongoose');
const stopSchema = require('./../schemas/stop');

const dbConfig = {
    user: process.env.MONGO_IMPORT_USER,
    pass: process.env.MONGO_IMPORT_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useFindAndModify: false
}

const timetableDb = mongoose.createConnection(process.env.MONGO_URL, dbConfig)
timetableDb.model('Stop', stopSchema);

module.exports = timetableDb;