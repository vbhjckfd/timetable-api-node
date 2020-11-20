const mongoose = require("mongoose");

const RouteSchema = new mongoose.Schema({
    external_id: {
        type: Number,
        required: true
    },
    short_name: {
      type: String,
      required: false
    },
    long_name: {
      type: String,
      required: false
    },
    trip_shape_map: {
      type: Map,
      of: Number
    },
    trip_direction_map: {
      type: Map,
      of: Number
    },
    shape_direction_map: {
      type: Map,
      of: Number
    },
    shapes: {
      type: Map,
      of: [[Number, Number]]
    },
    stops_by_shape: {
      type: Map,
      of: [Number]
    }
});

RouteSchema.methods.sample_trips = function () {
  let sampleTrips = [];
  this.trip_direction_map.forEach((value, key) => {
    sampleTrips[value] = key;
  })

  return sampleTrips;
};

RouteSchema.methods.shapes_by_direction = function () {
  let shapes = [];
  for (item of this.shape_direction_map.entries()) {
      shapes[item[1]] = this.shapes.get(item[0]);
  }

  return shapes;
};

module.exports = RouteSchema