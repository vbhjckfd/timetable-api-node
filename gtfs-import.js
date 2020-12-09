const gtfs = require('gtfs');
const config = require('./gtfs-import-config.json');

const timetableDb = require('./connections/timetableDb');
const microgizService = require("./services/microgizService");
const appHelpers = require("./utils/appHelpers");
const _ = require('lodash');

(async () => {
  await gtfs.import(config);
  console.log('Import Successful');

  const StopModel = timetableDb.model('Stop');
  const RouteModel = timetableDb.model('Route');

  const importedStops = await gtfs.getStops();
  const importedRoutes = await gtfs.getRoutes();
  let stopIds = [];

  if (!importedStops.length) {
      return res.sendStatus(500);
  }

  let importedRoutesIds = [];
  const routeRelatedPromises = importedRoutes.map(async r => {
      let routeModel = await RouteModel.findOne({external_id: r.route_id});

      if (!routeModel) {
          routeModel = await RouteModel.create({
              external_id: r.route_id,
              trip_shape_map: new Map(),
              trip_direction_map: new Map(),
              stops_by_shape: new Map(),
              shapes: new Map(),
              short_name: '',
              long_name: '',
          });
      }

      const mostPopularShapes = await appHelpers.getMostPopularShapes(r.route_id);

      if (!mostPopularShapes.length) {
          console.error(`Route ${r.route_id} - ${r.route_short_name} has no shapes`);
          return;
      }

      routeModel.short_name = appHelpers.normalizeRouteName(r.route_short_name);
      routeModel.long_name = r.route_long_name;

      const shapesRaw = await gtfs.getShapes({
          shape_id: mostPopularShapes
      }, ['shape_id', 'shape_pt_lat', 'shape_pt_lon']);

      let shapesToSave = new Map();
      shapesRaw.forEach(i => {
          if (!shapesToSave.has(i.shape_id)) {
              shapesToSave.set(i.shape_id, []);
          }

          shapesToSave.get(i.shape_id).push([i.shape_pt_lat, i.shape_pt_lon])
      })

      routeModel.shapes = shapesToSave;
      routeModel.markModified('shapes');

      let tripDirectionMap = new Map();
      let tripShapeMap = new Map();
      let shapeDirectionMap = new Map();

      const trips = await gtfs.getTrips({
          route_id: r.route_id,
          shape_id: Array.from(mostPopularShapes)
      }, ['trip_id', 'direction_id', 'shape_id']);

      trips.forEach(t => {
          tripDirectionMap.set(t.trip_id, t.direction_id);
          tripShapeMap.set(t.trip_id, t.shape_id);
          shapeDirectionMap.set(t.shape_id, t.direction_id);
      });

      routeModel.trip_direction_map = tripDirectionMap;
      routeModel.markModified('trip_direction_map');

      routeModel.trip_shape_map = tripShapeMap;
      routeModel.markModified('trip_shape_map');

      routeModel.shape_direction_map = shapeDirectionMap;
      routeModel.markModified('shape_direction_map');

      importedRoutesIds.push(routeModel.id);

      return routeModel.save();
  });

  await Promise.all(routeRelatedPromises);

  if (importedRoutesIds.length > 0) {
      await RouteModel.deleteMany({"_id" : { $nin : importedRoutesIds}})
  }

  console.log(`${routeRelatedPromises.length} routes processed`);

  const stopPromises = importedStops.map(async stopRow => {
      let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);

      if (null === code) {
          code = stopRow.stop_code
      } else if (Array.isArray(code)) {
          code = code[0]
      }

      // If still zero - skip it
      if (null === code) {
          console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
          return;
      }

      for (cleaner of ['(', ')']) {
          code = code.replace(cleaner, '')
      }
      code = Number(code);

      if (!code) {
          console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
          return;
      }

      if ([83].includes(code)) {
          console.warn(`Manually skipped stop with code ${code}`);
          return;
      }

      if (["45002"].includes(stopRow.stop_id)) {
          console.warn(`Manually skipped stop with microgiz id ${stopRow.stop_id}`);
          return;
      }

      let stop_name = stopRow.stop_name;

      for (cleaner of [`00${code}`, `0${code}`, code, '()', '" "', '(Т6)', '(0)', 'уточнити' , /^"{1}/ , /\s+$/, "\\"]) {
          stop_name = stop_name.replace(cleaner, '')
      }
      stop_name = stop_name.replace('""', '"')

      let stopModel = await StopModel.findOne({code: code});

      const stopData = {
          code: code,
          name: stop_name,
          microgiz_id: stopRow.stop_id,
          location: {
              type: "Point",
              coordinates: [stopRow.stop_lat, stopRow.stop_lon]
          },
          transfers: [],
      };

      if (!stopModel) {
          stopModel = await StopModel.create(stopData);
          await stopModel.save();
      }

      stopModel.name = stopData.name;
      stopModel.microgiz_id = stopData.microgiz_id;
      stopModel.location = stopData.location;

      stopIds.push(stopModel.id);

      stopModel.transfers = await microgizService.routesThroughStop(stopModel);
      stopModel.markModified('transfers');

      return stopModel.save();
  });

  console.log('Firing async process of stops processing');

  await Promise.all(stopPromises);

  if (stopIds.length > 0) {
      await StopModel.deleteMany({"_id" : { $nin : stopIds}})
  }

  console.log(`${stopPromises.length} stops processed`);

  const allStops = _(await StopModel.find({})).keyBy('microgiz_id').value();

  const routeModelsRaw = await RouteModel.find({});

  const routeStopsRelatedPromises = routeModelsRaw.map(async routeModel => {
      const stopTimes = await gtfs.getStoptimes({
          trip_id: routeModel.sample_trips()
      }, ['trip_id', 'stop_id']);

      let stopsByShape = new Map();
      for (key of [0, 1]) {
          stopsByShape.set(String(key), _(stopTimes)
              .filter(data => routeModel.trip_direction_map.get(data.trip_id) == key)
              .filter(st => !!allStops[st.stop_id])
              .map(st => allStops[st.stop_id].code)
              .value()
          )
      }

      routeModel.stops_by_shape = stopsByShape;
      routeModel.markModified('stops_by_shape');

      return routeModel.save();
  });

  await Promise.all(routeStopsRelatedPromises);
  console.log(`Calculated stops of ${routeStopsRelatedPromises.length} routes`);

})();