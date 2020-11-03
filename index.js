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
  useFindAndModify: false,
  poolSize: 20
}
mongoose.connect(process.env.MONGO_GTFS_URL, dbConfig);

const notFoundAction = require('./actions/notFoundAction');

const remapStopsInfoAction = require('./actions/remapStopsInfoAction');
const importGtfsStaticAction = require('./actions/importGtfsStaticAction');

const getClosestStopsAction = require('./actions/getClosestStopsAction');
const getSingleStopAction = require('./actions/getSingleStopAction');
const getStopTimetableAction = require('./actions/getStopTimetableAction');
const getStopStaticDataAction = require('./actions/getStopStaticDataAction');
const getAllStopsAction = require('./actions/getAllStopsAction');
const routeInfoDynamicAction = require('./actions/routeDynamicInfoAction');
const routeInfoStaticAction = require('./actions/routeStaticInfoAction');
const vehicleInfoAction = require('./actions/vehicleInfoAction');
const closestTransportAction = require('./actions/closestTransportAction');
const postFeedbackAction = require('./actions/postFeedbackAction');
const getFeedbackAction = require('./actions/getFeedbackAction');
const getGlobalMessagesAction = require('./actions/getGlobalMessagesAction');

const app = express();

app.use(cors());

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

app.get('/stops/:code/timetable', getStopTimetableAction);
app.get('/stops/:code/static', getStopStaticDataAction);
app.get('/stops/:code', getSingleStopAction);
app.get('/stops', getAllStopsAction);
app.get('/closest', getClosestStopsAction);

app.get('/import/gtfs_static', importGtfsStaticAction);
app.get('/import/remap_stops_info', remapStopsInfoAction);

app.get('/routes/dynamic/:name', routeInfoDynamicAction);
app.get('/routes/static/:name', routeInfoStaticAction);
app.get('/vehicle/:vehicleId', vehicleInfoAction);
app.get('/transport', closestTransportAction);

app.options('/feedback', cors());
app.post('/feedback', postFeedbackAction);
app.get('/feedback/:id', getFeedbackAction);
app.get('/messages', getGlobalMessagesAction);

app.use(notFoundAction);

process.on('exit', mongoose.disconnect);

exports.timetable = app;