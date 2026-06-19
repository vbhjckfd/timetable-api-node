import {
  importGtfs,
  openDb,
  getStops,
  getRoutes,
  getShapes,
  getTrips,
  getStoptimes,
} from "gtfs";
import {
  getTodayServiceIds,
  getWorkdayServiceIds,
  getWeekendServiceIds,
} from "./utils/appHelpers.js";

import PublicGoogleSheetsParser from "public-google-sheets-parser";
const spreadsheetId = "1AXRYgB4QqFaUCBEHJ8gueMnpYR2tI2NMgi2d8Ai7nAY";

import { readFile } from "fs/promises";
const config = JSON.parse(
  await readFile(new URL("./gtfs-import-config.json", import.meta.url)),
);

import loki from "lokijs";
const db = new loki("./database/Timetable", {
  autoload: true,
});

import { routesThroughStop } from "./services/microgizService.js";
import {
  getMostPopularShapes,
  normalizeRouteName,
  normalizeRouteNameBase,
  getDirectionByTrip,
  getSmapleTrips,
  shapes_by_direction,
} from "./utils/appHelpers.js";
const globalIgnoreStopList = ["45002", "45001", "2551851", "4671"];

(async () => {
  await importGtfs(config);
  console.log("Import Successful");
  await openDb(config);

  const importedStops = await getStops();
  const importedRoutes = await getRoutes();

  if (!importedStops.length) {
    console.error("GTFS import error!");
    return;
  }

  ["routes", "stops"].map((c) => db.removeCollection(c));

  const routesCollection = db.addCollection("routes", {
    indices: ["external_id"],
    unique: ["external_id"],
  });
  const stopsCollection = db.addCollection("stops", {
    indices: ["microgiz_id"],
    unique: ["code", "microgiz_id"],
  });

  const routeRelatedPromises = importedRoutes.map(async (r) => {
    let routeModel = {
      external_id: r.route_id,
      trip_shape_map: {},
      trip_direction_map: {},
      stops_by_shape: {},
      shapes: {},
      short_name: "",
      long_name: "",
      shape_direction_map: {},
      stop_departure_time_map: {},
    };

    if (["Е", "А07"].includes(r.route_short_name)) {
      return null;
    }

    const baseShortName = normalizeRouteNameBase(r.route_short_name);
    // Emergency/non-regular routes with no valid GTFS shapes.
    if (["А08", "А99"].includes(baseShortName)) {
      return null;
    }

    const mostPopularShapes = await getMostPopularShapes(r.route_id);

    //   if (!mostPopularShapes.length) {
    //       console.error(`Route ${r.route_id} - ${r.route_short_name} has no shapes`);
    //       return null;
    //   }

    routeModel.short_name = normalizeRouteName(r.route_short_name);
    routeModel.long_name = r.route_long_name;

    const shapesRaw = await getShapes(
      {
        shape_id: mostPopularShapes,
      },
      ["shape_id", "shape_pt_lat", "shape_pt_lon"],
      [["shape_pt_sequence", "ASC"]],
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

    let trips = [];

    trips = await getTrips(
      {
        route_id: r.route_id,
        shape_id: Array.from(mostPopularShapes),
        service_id: await getTodayServiceIds(),
      },
      ["trip_id", "direction_id", "shape_id"],
    );

    if (trips.length == 0) {
      trips = await getTrips(
        {
          route_id: r.route_id,
          service_id: await getTodayServiceIds(),
        },
        ["trip_id", "direction_id", "shape_id"],
      );
    }

    trips.forEach((t) => {
      tripShapeMap[t.trip_id] = t.shape_id;
      shapeDirectionMap[t.shape_id] = t.direction_id;
    });

    routeModel.trip_shape_map = tripShapeMap;
    routeModel.shape_direction_map = shapeDirectionMap;

    routeModel.trip_direction_map = trips.reduce((acc, t) => {
      let direction = getDirectionByTrip(t.trip_id, routeModel);

      if (direction === null) {
        direction = t.direction_id;
      }

      acc[t.trip_id] = direction;

      return acc;
    }, {});

    return routeModel;
  });

  const routeModels = await Promise.all(routeRelatedPromises);

  routesCollection.insert(routeModels.filter((r) => !!r));

  console.log(`${routeModels.length} routes processed`);
  let imported_stop_codes = {};

  const parser = new PublicGoogleSheetsParser(spreadsheetId);
  const items = await parser.parse();

  const engNames = items.reduce((acc, cur) => {
    acc[cur["№ зупин-ки"]] = cur["Назва зупинки латиницею"];
    return acc;
  }, {});

  const stopPromises = importedStops.map(async (stopRow) => {
    let code = stopRow.stop_name.match(/(\([\-\d]+\))/i);
    if (Array.isArray(code)) {
      code = code[0];
    }

    // If still zero - skip it
    if (null === code) {
      console.warn(
        `Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`,
      );
      return null;
    }

    for (const cleaner of ["(", ")"]) {
      code = code.replace(cleaner, "");
    }
    code = Number(code);

    if (!code) {
      console.warn(
        `Skipped stop with microgiz id ${stopRow.stop_id}, bad code in ${stopRow.stop_name}`,
      );
      return null;
    }

    if ([83].includes(code)) {
      console.warn(`Manually skipped stop with code ${code}`);
      return null;
    }

    if (globalIgnoreStopList.includes(stopRow.stop_id)) {
      console.warn(
        `Manually skipped stop with microgiz id ${stopRow.stop_id} - ${stopRow.stop_name}`,
      );
      return;
    }

    let stop_name = stopRow.stop_name;

    for (const cleaner of [
      `00${code}`,
      `0${code}`,
      code,
      "()",
      '" "',
      "(Т6)",
      "(0)",
      "уточнити",
      /^"{1}/,
      /\s+$/,
      "\\",
    ]) {
      stop_name = stop_name.replace(cleaner, "");
    }
    stop_name = stop_name.replace('""', '"');

    let stopModel = {
      code: code,
      name: stop_name,
      eng_name: engNames[code] || "",
      microgiz_id: stopRow.stop_id,
      location: {
        type: "Point",
        coordinates: [stopRow.stop_lat, stopRow.stop_lon],
      },
      transfers: [],
    };

    if (imported_stop_codes[code]) {
      console.error(
        `Double stop code ${code} in row ${JSON.stringify(stopRow)}, already present in ${JSON.stringify(imported_stop_codes[code])}`,
      );
      return null;
    }

    imported_stop_codes[code] = stopRow;
    return stopModel;
  });

  console.log("Firing async process of stops transfers");
  const stopsModels = await Promise.all(stopPromises);
  stopsCollection.insert(stopsModels.filter((r) => !!r));

  console.log(`${stopPromises.length} stops processed`);

  const allStops = Object.fromEntries(
    stopsModels.filter(Boolean).map((s) => [s.microgiz_id, s]),
  );

  const [workdayServiceIds, weekendServiceIds] = await Promise.all([
    getWorkdayServiceIds(),
    getWeekendServiceIds(),
  ]);

  async function buildDepartureTimeMap(routeId, serviceIds) {
    if (!serviceIds.length) return {};
    const trips = await getTrips(
      { route_id: routeId, service_id: serviceIds },
      ["trip_id"],
    );
    if (!trips.length) return {};
    const stopTimes = await getStoptimes(
      { trip_id: trips.map((t) => t.trip_id) },
      ["stop_id", "departure_time"],
      [["departure_time", "ASC"]],
    );
    const grouped = Object.groupBy(stopTimes, (t) => t.stop_id);
    return Object.fromEntries(
      Object.entries(grouped).map(([stopId, times]) => [
        stopId,
        [...new Set(times.map((t) => t.departure_time.slice(0, 5)))],
      ]),
    );
  }

  const routeStopsRelatedPromises = routesCollection
    .find()
    .map(async (routeModel) => {
      const stopTimes = await getStoptimes(
        {
          trip_id: getSmapleTrips(routeModel),
        },
        ["trip_id", "stop_id", "stop_sequence"],
        [["stop_sequence", "ASC"]],
      );

      let stopsByShape = {};
      for (const key of [0, 1]) {
        stopsByShape[String(key)] = stopTimes
          .filter((data) => routeModel.trip_direction_map[data.trip_id] == key)
          .filter((st) => !globalIgnoreStopList.includes(st.stop_id))
          .map((st) => (allStops[st.stop_id] ? allStops[st.stop_id].code : null))
          .filter((st) => !!st);
      }

      for (const key of ["0", "1"]) {
        const otherShapeStops = stopsByShape[String(Math.abs(key - 1))];

        if (!stopsByShape[key][0]) {
          stopsByShape[key][0] = otherShapeStops.at(-1);
        }

        if (!stopsByShape[key].at(-1)) {
          stopsByShape[key].pop();
          stopsByShape[key].push(otherShapeStops[0]);
        }
      }

      for (const key of ["0", "1"]) {
        const otherShapeStops = stopsByShape[String(Math.abs(key - 1))];

        const lastStopOfThisShape = stopsByShape[key].at(-1);
        const firstStopOfOtherShape = otherShapeStops[0];
        if (lastStopOfThisShape !== firstStopOfOtherShape) {
          stopsByShape[key].push(firstStopOfOtherShape);
        }
      }

      routeModel.stops_by_shape = stopsByShape;

      const allRouteTrips = Object.keys(routeModel.trip_direction_map);
      const allStopTimes = await getStoptimes(
        {
          trip_id: allRouteTrips,
        },
        ["stop_id", "departure_time"],
        [["departure_time", "ASC"]],
      );

      const grouped = Object.groupBy(allStopTimes, (t) => t.stop_id);
      routeModel.stop_departure_time_map = Object.fromEntries(
        Object.entries(grouped).map(([stopId, times]) => [
          stopId,
          [...new Set(times.map((t) => t.departure_time.slice(0, 5)))],
        ]),
      );

      [
        routeModel.stop_departure_time_map_workday,
        routeModel.stop_departure_time_map_weekend,
      ] = await Promise.all([
        buildDepartureTimeMap(routeModel.external_id, workdayServiceIds),
        buildDepartureTimeMap(routeModel.external_id, weekendServiceIds),
      ]);

      routesCollection.update(routeModel);

      return routeModel;
    });

  console.log("Firing async process of route stops processing");
  await Promise.all(routeStopsRelatedPromises);

  const stopTransferPromises = stopsCollection.find().map(async (s) => {
    s.transfers = await routesThroughStop(s, routesCollection, stopsCollection);

    stopsCollection.update(s);

    return s;
  });

  console.log("Firing async process of stops transfers processing");
  await Promise.all(stopTransferPromises);

  // ── Shape quality check ────────────────────────────────────────────────────
  console.log("\nShape quality check…");
  const TERMINAL_THRESHOLD_M = 200;
  // Gaps up to this are bridged with a straight segment to the terminal stop
  // (covers rural terminal loops the GTFS shape stops short of); anything
  // larger is a genuine geometry mismatch and gets flagged.
  const EXTEND_THRESHOLD_M = 500;

  function distM(lat1, lon1, lat2, lon2) {
    const R = 6_371_000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  let passed = 0, failed = 0, autoFlipped = 0, autoExtended = 0, autoSynthesized = 0;
  for (const route of routesCollection.find()) {
    const issues = [];

    // Fallback: the GTFS feed ships some routes with no shape geometry at all
    // (every trip has shape_id = null). Build an approximate polyline from the
    // ordered stop sequence so the route still renders on the map.
    route.synthetic_shape_dirs = [];
    for (const dir of [0, 1]) {
      if (shapes_by_direction(route)[dir]?.length) continue;
      const codes = route.stops_by_shape?.[String(dir)] ?? [];
      const pts = codes
        .map((c) => stopsCollection.findOne({ code: c }))
        .filter(Boolean)
        .map((s) => s.location.coordinates);
      if (pts.length < 2) continue;
      const shapeId = `synthetic-${route.external_id}-${dir}`;
      route.shapes[shapeId] = pts;
      route.shape_direction_map[shapeId] = dir;
      route.synthetic_shape_dirs.push(dir);
      autoSynthesized++;
      issues.push(`dir${dir}: synthesized from ${pts.length} stops`);
    }

    const shapeCount = Object.keys(route.shapes).length;

    if (shapeCount !== 2) {
      issues.push(`${shapeCount} shape(s) instead of 2`);
    } else {
      const shapesByDir = shapes_by_direction(route);

      for (const dir of [0, 1]) {
        const shape = shapesByDir[dir];
        const codes = route.stops_by_shape?.[String(dir)];

        if (!shape?.length)  { issues.push(`dir${dir}: no shape points`); continue; }
        if (!codes?.length)  { issues.push(`dir${dir}: no stops`);        continue; }

        const firstStop = stopsCollection.findOne({ code: codes[0] });
        const lastStop  = stopsCollection.findOne({ code: codes.at(-1) });

        if (!firstStop) { issues.push(`dir${dir}: stop ${codes[0]} not found`);     continue; }
        if (!lastStop)  { issues.push(`dir${dir}: stop ${codes.at(-1)} not found`); continue; }

        const [fLat, fLon] = firstStop.location.coordinates;
        const [lLat, lLon] = lastStop.location.coordinates;

        const dStartToFirst = distM(shape[0][0],     shape[0][1],     fLat, fLon);
        const dEndToLast    = distM(shape.at(-1)[0], shape.at(-1)[1], lLat, lLon);
        const dStartToLast  = distM(shape[0][0],     shape[0][1],     lLat, lLon);
        const dEndToFirst   = distM(shape.at(-1)[0], shape.at(-1)[1], fLat, fLon);

        const ok      = dStartToFirst <= TERMINAL_THRESHOLD_M && dEndToLast  <= TERMINAL_THRESHOLD_M;
        const flipped = dStartToLast  <= TERMINAL_THRESHOLD_M && dEndToFirst <= TERMINAL_THRESHOLD_M;

        if (ok) continue;

        if (flipped) {
          shape.reverse();
          autoFlipped++;
          issues.push(`dir${dir}: reversed`);
        } else {
          // Pick the better orientation; bridge a small gap to the terminals.
          const flip = Math.max(dStartToLast, dEndToFirst) <
                       Math.max(dStartToFirst, dEndToLast);
          if (flip) shape.reverse();

          const startGap = flip ? dEndToFirst : dStartToFirst;
          const endGap   = flip ? dStartToLast : dEndToLast;

          if (Math.max(startGap, endGap) <= EXTEND_THRESHOLD_M) {
            if (startGap > TERMINAL_THRESHOLD_M) shape.unshift([fLat, fLon]);
            if (endGap   > TERMINAL_THRESHOLD_M) shape.push([lLat, lLon]);
            autoExtended++;
            issues.push(`dir${dir}: bridged ${Math.round(startGap)}m/${Math.round(endGap)}m to stops${flip ? " (after flip)" : ""}`);
          } else {
            if (flip) shape.reverse(); // genuine issue — leave shape as imported, just flag

            // Classify each bad end: a turnaround loop reaches the terminal but
            // its endpoint overshoots; a genuine short never comes close.
            const near = (lat, lon) => {
              let m = Infinity;
              for (const p of shape) m = Math.min(m, distM(p[0], p[1], lat, lon));
              return m;
            };
            const desc = (gap, lat, lon, code) => {
              const n = near(lat, lon);
              return n <= TERMINAL_THRESHOLD_M
                ? `loop past stop ${code} (overshoots ${Math.round(gap)}m, reaches ${Math.round(n)}m)`
                : `${Math.round(n)}m from stop ${code}`;
            };

            const parts = [];
            if (startGap > TERMINAL_THRESHOLD_M) parts.push(desc(startGap, fLat, fLon, codes[0]));
            if (endGap   > TERMINAL_THRESHOLD_M) parts.push(desc(endGap,   lLat, lLon, codes.at(-1)));
            issues.push(`dir${dir}: ${parts.join("; ")}`);
          }
        }
      }
    }

    if (issues.length) {
      const autoResolved = issues.every(
        i => /reversed|bridged|synthesized/.test(i),
      );
      if (autoResolved) {
        routesCollection.update(route);
        passed++;
        console.log(`  ↩ ${route.short_name} (${route.external_id}): ${issues.join("; ")}`);
      } else {
        failed++;
        console.warn(`  ✗ ${route.short_name} (${route.external_id}): ${issues.join("; ")}`);
      }
    } else {
      passed++;
    }
  }
  console.log(`  ${passed} routes OK (${autoFlipped} reversed, ${autoExtended} bridged, ${autoSynthesized} synthesized), ${failed} routes with issues`);

  db.saveDatabase();
  console.log(`Calculated stops of ${routeStopsRelatedPromises.length} routes`);
})();
