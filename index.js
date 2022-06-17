import mongoose from 'mongoose';

import 'dotenv/config'

import path from 'path';
const PORT = process.env.PORT || 8080;

import {openDb} from 'gtfs';
import { readFile } from 'fs/promises';
import cors from 'cors';
import express from 'express';
import bodyParser from 'body-parser';
import localDb from './connections/timetableSqliteDb.js';

import notFoundAction from './actions/notFoundAction.js';

import getClosestStopsAction from './actions/getClosestStopsAction.js';
import getSingleStopAction from './actions/getSingleStopAction.js';
import getStopTimetableAction from './actions/getStopTimetableAction.js';
import getStopStaticDataAction from './actions/getStopStaticDataAction.js';
import getAllStopsAction from './actions/getAllStopsAction.js';
import routeInfoDynamicAction from './actions/routeDynamicInfoAction.js';
import routeInfoStaticAction from './actions/routeStaticInfoAction.js';
import vehicleInfoAction from './actions/vehicleInfoAction.js';
import closestTransportAction from './actions/closestTransportAction.js';
import postFeedbackAction from './actions/postFeedbackAction.js';
import getFeedbackAction from './actions/getFeedbackAction.js';
import getGlobalMessagesAction from './actions/getGlobalMessagesAction.js';
import getAllRoutesAction from './actions/getAllRoutesAction.js';

const __dirname = path.resolve();
const app = express();

app.use(cors());

app.use(bodyParser.json())

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

app.get('/stops/:code/timetable', getStopTimetableAction);
app.get('/stops/:code/static', getStopStaticDataAction);
app.get('/stops/:code', getSingleStopAction);
app.get('/stops.json', getAllStopsAction);
app.get('/stops', getAllStopsAction);
app.get('/closest', getClosestStopsAction);

app.get('/routes', getAllRoutesAction);
app.get('/routes/dynamic/:name', routeInfoDynamicAction);
app.get('/routes/static/:name', routeInfoStaticAction);
app.get('/vehicle/:vehicleId', vehicleInfoAction);
app.get('/transport', closestTransportAction);

app.options('/feedback', cors());
app.post('/feedback', postFeedbackAction);
app.get('/feedback/:id', getFeedbackAction);
app.get('/messages', getGlobalMessagesAction);

app.get('/last-modified.txt', (req, res, next) => {
  res.set('Cache-Control', `public, max-age=0, s-maxage=${5 * 60}`)
  res.sendFile(path.join(__dirname, 'last-modified.txt'));
})

app.get('/favicon.ico', (req, res, next) => {
  res.set('Cache-Control', `public, max-age=0, s-maxage=${3600 * 24 * 31}`);
  res.sendFile(path.join(__dirname, 'favicon.ico'));
});

app.use(notFoundAction);

process.on('exit', mongoose.disconnect);

app.on('ready', () => {
  app.listen(PORT, () => {
    console.log('Started!');
  })
});

localDb.loadDatabase({}, async () => {  
  const gtfsDbConfig = JSON.parse(
    await readFile(new URL('./gtfs-import-config.json', import.meta.url))
  );

  await openDb(gtfsDbConfig);

  app.emit('ready');
});