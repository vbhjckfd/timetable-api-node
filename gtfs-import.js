import { importGtfs, openDb, getStops, getRoutes, getShapes, getTrips, getStoptimes } from 'gtfs';

import { readFile } from 'fs/promises';
const config = JSON.parse(
    await readFile(new URL('./gtfs-import-config.json', import.meta.url))
);

import loki from 'lokijs';
const db = new loki('./database/Timetable', {
    autoload: true
});

import { routesThroughStop } from "./services/microgizService.js";
import { getMostPopularShapes, normalizeRouteName, getDirectionByTrip, getSmapleTrips } from "./utils/appHelpers.js";
import _ from 'lodash';

const globalIgnoreStopList = ['45002', '45001', '2551851', '4671'];

(async () => {
  await importGtfs(config);
  console.log('Import Successful');
  await openDb(config);

  const importedStops = await getStops();
  const importedRoutes = await getRoutes();

  if (!importedStops.length) {
      console.error('GTFS import error!');
      return;
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
        shape_direction_map: {},
      }

      if (['Е'].includes(r.route_short_name)) {
        return null;
    }

      const mostPopularShapes = await getMostPopularShapes(r.route_id);

      if (!mostPopularShapes.length) {
          console.error(`Route ${r.route_id} - ${r.route_short_name} has no shapes`);
          return null;
      }

      routeModel.short_name = normalizeRouteName(r.route_short_name);
      routeModel.long_name = r.route_long_name;

      const shapesRaw = await getShapes({
            shape_id: mostPopularShapes
        },
        ['shape_id', 'shape_pt_lat', 'shape_pt_lon'],
        [
            ['shape_pt_sequence', 'ASC']
        ]
      );

      routeModel.shapes = shapesRaw.reduce((acc, i) => {
        if (!acc[i.shape_id]) {
            acc[i.shape_id] = [];
        }
        acc[i.shape_id].push([i.shape_pt_lat, i.shape_pt_lon]);
        return acc;
      }, {});

      let tripShapeMap = {};
      let shapeDirectionMap = {};

      const trips = await getTrips({
          route_id: r.route_id,
          shape_id: Array.from(mostPopularShapes)
      }, ['trip_id', 'direction_id', 'shape_id']);

      trips.forEach(t => {
          tripShapeMap[t.trip_id] = t.shape_id;
          shapeDirectionMap[t.shape_id] = Object.keys(routeModel.shapes).indexOf(t.shape_id);
      });

      routeModel.trip_shape_map = tripShapeMap;
      routeModel.shape_direction_map = shapeDirectionMap;

      routeModel.trip_direction_map = trips.reduce((acc, t) => {
        acc[t.trip_id] = getDirectionByTrip(t.trip_id, routeModel);
        return acc;
      }, {});

      return routeModel;
  });

  const routeModels = await Promise.all(routeRelatedPromises);

  routesCollection.insert(routeModels.filter(r => !!r));

  console.log(`${routeModels.length} routes processed`);
  let imported_stop_codes = {}

  const stopPromises = importedStops.map(async stopRow => {
      let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);
      if (Array.isArray(code)) {
          code = code[0]
      }

      // If still zero - skip it
      if (null === code) {
          console.warn(`Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`);
          return null;
      }

      for (const cleaner of ['(', ')']) {
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

      if (globalIgnoreStopList.includes(stopRow.stop_id)) {
          console.warn(`Manually skipped stop with microgiz id ${stopRow.stop_id} - ${stopRow.stop_name}`);
          return;
      }

      let stop_name = stopRow.stop_name;

      for (const cleaner of [`00${code}`, `0${code}`, code, '()', '" "', '(Т6)', '(0)', 'уточнити' , /^"{1}/ , /\s+$/, "\\"]) {
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


      if (imported_stop_codes[code]) {
          console.error(`Double stop code ${code} in row ${JSON.stringify(stopRow)}, already present in ${JSON.stringify(imported_stop_codes[code])}`)
          return null
      }

      imported_stop_codes[code] = stopRow
      return stopModel;
  });

  console.log('Firing async process of stops transfers');
  const stopsModels = await Promise.all(stopPromises);
  stopsCollection.insert(stopsModels.filter(r => !!r));

  console.log(`${stopPromises.length} stops processed`);

  const allStops = _(stopsModels).keyBy('microgiz_id').value();

  const routeStopsRelatedPromises = routesCollection.find().map(async routeModel => {
      const stopTimes = await getStoptimes(
        {
            trip_id: getSmapleTrips(routeModel)
        },
        ['trip_id', 'stop_id', 'stop_sequence'],
        [['stop_sequence', 'ASC']]
      );

      let stopsByShape = {};
      for (const key of [0, 1]) {
          stopsByShape[String(key)] = _(stopTimes)
              .filter(data => routeModel.trip_direction_map[data.trip_id] == key)
              .filter(st => !globalIgnoreStopList.includes(st.stop_id))
              .map(st => allStops[st.stop_id] ? allStops[st.stop_id].code : null)
              .filter(st => !!st)
              .value();
      }

      for (const key of ["0", "1"]) {
        const otherShapeStops = stopsByShape[String(Math.abs(key - 1))];

        if (!stopsByShape[key][0]) {
            stopsByShape[key][0] = _(otherShapeStops).last();
        }

        if (!_(stopsByShape[key]).last()) {
            stopsByShape[key].pop();
            stopsByShape[key].push(otherShapeStops[0]);
        }
      }

      for (const key of ["0", "1"]) {
        const otherShapeStops = stopsByShape[String(Math.abs(key - 1))];

        const lastStopOfThisShape = _(stopsByShape[key]).last();
        const firstStopOfOtherShape = _(otherShapeStops).first();
        if (lastStopOfThisShape !== firstStopOfOtherShape) {
            stopsByShape[key].push(firstStopOfOtherShape)
        }
      }

      routeModel.stops_by_shape = stopsByShape;

      routesCollection.update(routeModel);

      return routeModel;
  });

  console.log('Firing async process of route stops processing');
  await Promise.all(routeStopsRelatedPromises);

  const stopTransferPromises = stopsCollection.find().map(async (s) => {
      s.transfers = await routesThroughStop(s, routesCollection, stopsCollection);

      stopsCollection.update(s);

      return s;
  });

  console.log('Firing async process of stops transfers processing');
  await Promise.all(stopTransferPromises);

  db.saveDatabase();
  console.log(`Calculated stops of ${routeStopsRelatedPromises.length} routes`);

})();