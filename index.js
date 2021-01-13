const mongoose = require('mongoose');

const dotenv = require('dotenv');
dotenv.config();

const PORT = process.env.PORT || 8080;

const cors = require('cors')
const express = require('express');

const notFoundAction = require('./actions/notFoundAction');

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

app.on('ready', () => {
  app.listen(PORT, () => {
    console.log('Started!');
  })
});

const timetableDb = require('./connections/timetableSqliteDb');
timetableDb.loadDatabase({}, async () => {
  const gtfs = require('gtfs');
  const gtfsDbConfig = require('./gtfs-import-config.json');
  await gtfs.openDb(gtfsDbConfig);

  app.emit('ready');
});