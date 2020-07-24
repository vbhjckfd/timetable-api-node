const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true
    },
},
{ timestamps: true }
);

module.exports = MessageSchema