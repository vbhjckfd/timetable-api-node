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
    user_uuid: {
      type: String,
      required: false
    },
    response: {
      type: String,
      required: false
    }
});

module.exports = FeedbackSchema