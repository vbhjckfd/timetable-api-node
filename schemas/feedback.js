const mongoose = require("mongoose");

const FeedbackSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true
    },
    uuid: {
      type: String,
      required: true
    },
    response: {
      type: String,
      required: false
    }
});

module.exports = FeedbackSchema