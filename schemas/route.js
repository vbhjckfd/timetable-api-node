const mongoose = require("mongoose");

const RouteSchema = new mongoose.Schema({
    external_id: {
        type: Number,
        required: true
    },
    trip_shape_map: {
      type: Map,
      of: Number
    }
});

module.exports = RouteSchema