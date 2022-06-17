import mongoose from "mongoose";

const PointSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Point'],
    required: true
  },
  coordinates: {
    type: [Number],
    required: true
  }
});

const FeedbackSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true
    },
    user_uuid: {
      type: String,
      required: false
    },
    is_response: {
      type: Boolean,
      required: true
    },
    location: {
      type: PointSchema,
      required: false
    },
    user_agent: {
      type: String,
      required: false
    },
},
{ timestamps: true }
);

export default FeedbackSchema