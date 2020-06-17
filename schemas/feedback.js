const mongoose = require("mongoose");

const FeedbackSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true
    },
});

module.exports = FeedbackSchema