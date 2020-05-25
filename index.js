const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const cors = require('cors')
const express = require('express');

const dbConfig = {
  user: process.env.MONGO_IMPORT_USER,
  pass: process.env.MONGO_IMPORT_PASSWORD,
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false
}
mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

const notFoundAction = require('./actions/notFoundAction');
const getClosestStopsAction = require('./actions/getClosestStopsAction');
const getSingleStopAction = require('./actions/getSingleStopAction');
const importGtfsStaticAction = require('./actions/importGtfsStaticAction');
const routeInfoDynamicAction = require('./actions/routeDynamicInfoAction');
const routeInfoStaticAction = require('./actions/routeStaticInfoAction');
const vehicleInfoAction = require('./actions/vehicleInfoAction');

const app = express();

app.use(cors());

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

app.get('/stops/:code', getSingleStopAction);
app.get('/closest', getClosestStopsAction);
app.get('/import/gtfs_static', importGtfsStaticAction);
app.get('/routes/dynamic/:name', routeInfoDynamicAction);
app.get('/routes/static/:name', routeInfoStaticAction);
app.get('/vehicle/:vehicleId', vehicleInfoAction);
app.use(notFoundAction);

process.on('exit', mongoose.disconnect);

exports.timetable = app;