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
  id: {
    type: Number,
    required: false
  },
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
  shape_id: {
    type: Number,
    required: false
  },
  direction_id: {
    type: Number,
    required: false
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
}, {
  skipVersioning: { transfers: true }
});

StopSchema.index({ "location": "2dsphere" });

module.exports = StopSchema