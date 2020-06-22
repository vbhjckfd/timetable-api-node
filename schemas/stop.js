const mongoose = require("mongoose");

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

const TransferSchema = new mongoose.Schema({
  color: {
    type: String,
    required: true
  },
  route: {
    type: String,
    required: true
  },
  vehicle_type: {
    type: String,
    required: true
  },
});

const StopSchema = new mongoose.Schema({
    code: {
        type: Number,
        required: true
    },
    microgiz_id: {
      type: Number,
      required: false
    },
    easyway_id: {
        type: Number,
        required: false
    },
    name: {
        type: String,
        required: true
    },
    location: {
        type: PointSchema
    },
    transfers: [TransferSchema]
});

StopSchema.index({ "location": "2dsphere" });

module.exports = StopSchema