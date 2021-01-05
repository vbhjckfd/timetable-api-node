const gtfs = require('gtfs');
const config = require('./gtfs-import-config.json');

const loki = require('lokijs')
const db = new loki('./database/Timetable', {
    autoload: true
});

const microgizService = require("./services/microgizService");
const appHelpers = require("./utils/appHelpers");
const _ = require('lodash');

(async () => {
  await gtfs.import(config);
  console.log('Import Successful');
//   await gtfs.openDb(config);

  const importedStops = await gtfs.getStops();
  const importedRoutes = await gtfs.getRoutes();

  if (!importedStops.length) {
      return res.sendStatus(500);
  }

  ['routes', 'stops'].map(c => db.removeCollection(c));

  const routesCollection = db.addCollection('routes', { indices: ['external_id'], unique: ["external_id"] });
  const stopsCollection = db.addCollection('stops', { indices: ['microgiz_id'], unique: ["code", "microgiz_id"] });

  const routeRelatedPromises = importedRoutes.map(async r => {
      let routeModel = {
        external_id: r.route_id,
        trip_shape_map: {},
        trip_direction_map: {},
        stops_by_shape: {},
        shapes: {},
        short_name: '',
        long_name: '',
    }

      const mostPopularShapes = await appHelpers.getMostPopularShapes(r.route_id);

      if (!mostPopularShapes.length) {
          console.error(`Route ${r.route_id} - ${r.route_short_name} has no shapes`);
          return null;
      }

      routeModel.short_name = appHelpers.normalizeRouteName(r.route_short_name);
      routeModel.long_name = r.route_long_name;

      const shapesRaw = await gtfs.getShapes({
          shape_id: mostPopularShapes
      }, ['shape_id', 'shape_pt_lat', 'shape_pt_lon']);

      let shapesToSave = {};
      shapesRaw.forEach(i => {
          if (!shapesToSave[i.shape_id]) {
              shapesToSave[i.shape_id] = [];
          }

          shapesToSave[i.shape_id].push([i.shape_pt_lat, i.shape_pt_lon])
      })

      routeModel.shapes = shapesToSave;

      let tripDirectionMap = {};
      let tripShapeMap = {};
      let shapeDirectionMap = {};

      const trips = await gtfs.getTrips({
          route_id: r.route_id,
          shape_id: Array.from(mostPopularShapes)
      }, ['trip_id', 'direction_id', 'shape_id']);

      trips.forEach(t => {
          tripDirectionMap[t.trip_id] = t.direction_id;
          tripShapeMap[t.trip_id] = t.shape_id;
          shapeDirectionMap[t.shape_id] = t.direction_id;
      });

      routeModel.trip_direction_map = tripDirectionMap;
      routeModel.trip_shape_map = tripShapeMap;
      routeModel.shape_direction_map = shapeDirectionMap;

      return routeModel;
  });

  const routeModels = await Promise.all(routeRelatedPromises);

  routesCollection.insert(routeModels.filter(r => !!r));

  console.log(`${routeModels.length} routes processed`);

  const stopPromises = importedStops.map(async stopRow => {
      console.log(stopRow.stop_id, stopRow.stop_name);
      let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);

      if (null === code) {
          code = stopRow.stop_code
      } else if (Array.isArray(code)) {
          code = code[0]
      }

      // If still zero - skip it
      if (null === code) {
          console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
          return null;
      }

      for (cleaner of ['(', ')']) {
          code = code.replace(cleaner, '')
      }
      code = Number(code);

      if (!code) {
          console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
          return null;
      }

      if ([83].includes(code)) {
          console.warn(`Manually skipped stop with code ${code}`);
          return null;
      }

      if (["45002", "45001", "4671"].includes(stopRow.stop_id)) {
          console.warn(`Manually skipped stop with microgiz id ${stopRow.stop_id}`);
          return;
      }

      let stop_name = stopRow.stop_name;

      for (cleaner of [`00${code}`, `0${code}`, code, '()', '" "', '(Т6)', '(0)', 'уточнити' , /^"{1}/ , /\s+$/, "\\"]) {
          stop_name = stop_name.replace(cleaner, '')
      }
      stop_name = stop_name.replace('""', '"')

      let stopModel = {
          code: code,
          name: stop_name,
          microgiz_id: stopRow.stop_id,
          location: {
              type: "Point",
              coordinates: [stopRow.stop_lat, stopRow.stop_lon]
          },
          transfers: [],
      };

      stopModel.transfers = await microgizService.routesThroughStop(stopModel, routesCollection);

      return stopModel;
  });

  console.log('Firing async process of stops transfers');
  const stopsModels = await Promise.all(stopPromises);
  stopsCollection.insert(stopsModels.filter(r => !!r));

  console.log(`${stopPromises.length} stops processed`);

  const allStops = _(stopsModels).keyBy('microgiz_id').value();

  const routeStopsRelatedPromises = routesCollection.find({}).map(async routeModel => {
      const stopTimes = await gtfs.getStoptimes({
          trip_id: appHelpers.getSmapleTrips(routeModel)
      }, ['trip_id', 'stop_id']);

      let stopsByShape = {};
      for (key of [0, 1]) {
          stopsByShape[String(key)] = _(stopTimes)
              .filter(data => routeModel.trip_direction_map[data.trip_id] == key)
              .filter(st => !!allStops[st.stop_id])
              .map(st => allStops[st.stop_id].code)
              .value();
      }

      routeModel.stops_by_shape = stopsByShape;

      routesCollection.update(routeModel);

      return routeModel;
  });

  console.log('Firing async process of route stops processing');
  await Promise.all(routeStopsRelatedPromises);

  db.saveDatabase();
  console.log(`Calculated stops of ${routeStopsRelatedPromises.length} routes`);

})();