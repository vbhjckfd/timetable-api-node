import db from "../connections/timetableSqliteDb.js";
import { formatRouteName } from "../utils/appHelpers.js";

// Route/stop data only changes on GTFS import (separate process + restart),
// so the routes×stops index is built once per process, not per request.
let routesIndexCache = null;

// Test seam: drop the memoized index so cases stay isolated.
export function __resetRoutesIndexCache() {
  routesIndexCache = null;
}

function buildRoutesIndex() {
  if (routesIndexCache) return routesIndexCache;

  const routes = db.getCollection("routes").find({});
  const stopNames = {};
  db.getCollection("stops").find({}).forEach((s) => {
    stopNames[s.code] = s.name ?? String(s.code);
  });

  // routesByStop[code] = [{ routeKey, route, dir, stops }]
  const routesByStop = {};
  for (const route of routes) {
    for (const [dir, stops] of Object.entries(route.stops_by_shape ?? {})) {
      const info = { route, dir: parseInt(dir, 10), stops };
      for (const code of stops) {
        if (!routesByStop[code]) routesByStop[code] = [];
        routesByStop[code].push(info);
      }
    }
  }
  routesIndexCache = { routesByStop, stopNames };
  return routesIndexCache;
}

function findTripOptions(originCode, destCode) {
  const { routesByStop, stopNames } = buildRoutesIndex();
  const directOptions = [];
  const transferOptions = [];

  // Direct: find routes where origin appears before destination
  for (const info of routesByStop[originCode] ?? []) {
    const { route, dir, stops } = info;
    const oIdx = stops.indexOf(originCode);
    const dIdx = stops.indexOf(destCode);
    if (dIdx > oIdx) {
      directOptions.push({
        type: "direct",
        route: formatRouteName(route.short_name),
        direction: dir,
        board_stop_code: originCode,
        board_stop_name: stopNames[originCode] ?? String(originCode),
        alight_stop_code: destCode,
        alight_stop_name: stopNames[destCode] ?? String(destCode),
        stops_count: dIdx - oIdx,
      });
    }
  }

  if (directOptions.length === 0) {
    // 1-transfer: build map of stops-before-destination indexed by stop code
    const preDestByStop = {};
    for (const info of routesByStop[destCode] ?? []) {
      const { route, dir, stops } = info;
      const dIdx = stops.indexOf(destCode);
      for (let i = 0; i < dIdx; i++) {
        const code = stops[i];
        if (!preDestByStop[code]) preDestByStop[code] = [];
        preDestByStop[code].push({ route, dir, stops, dIdx });
      }
    }

    const seen = new Set();
    outer: for (const info1 of routesByStop[originCode] ?? []) {
      const { route: r1, stops: stops1 } = info1;
      const oIdx = stops1.indexOf(originCode);
      for (let i = oIdx + 1; i < stops1.length; i++) {
        const transferCode = stops1[i];
        if (!preDestByStop[transferCode]) continue;
        for (const info2 of preDestByStop[transferCode]) {
          const { route: r2, stops: stops2, dIdx } = info2;
          const tIdx2 = stops2.indexOf(transferCode);
          const key = `${r1.short_name}+${r2.short_name}:${transferCode}`;
          if (seen.has(key)) continue;
          seen.add(key);
          transferOptions.push({
            type: "transfer",
            route1: formatRouteName(r1.short_name),
            route2: formatRouteName(r2.short_name),
            board_stop_code: originCode,
            board_stop_name: stopNames[originCode] ?? String(originCode),
            transfer_stop_code: transferCode,
            transfer_stop_name: stopNames[transferCode] ?? String(transferCode),
            alight_stop_code: destCode,
            alight_stop_name: stopNames[destCode] ?? String(destCode),
            stops_count_1: i - oIdx,
            stops_count_2: dIdx - tIdx2,
          });
          if (transferOptions.length >= 5) break outer;
        }
      }
    }
  }

  directOptions.sort((a, b) => a.stops_count - b.stops_count);
  transferOptions.sort((a, b) => (a.stops_count_1 + a.stops_count_2) - (b.stops_count_1 + b.stops_count_2));

  return [...directOptions.slice(0, 5), ...transferOptions.slice(0, 3)];
}

export default async (req, res) => {
  const originCode = parseInt(req.query.origin, 10);
  const destCode = parseInt(req.query.destination, 10);

  if (!Number.isInteger(originCode) || originCode <= 0) {
    return res.status(400).json({ error: "Invalid origin stop code" });
  }
  if (!Number.isInteger(destCode) || destCode <= 0) {
    return res.status(400).json({ error: "Invalid destination stop code" });
  }
  if (originCode === destCode) {
    return res.status(400).json({ error: "Origin and destination must be different stops" });
  }

  const stopsCollection = db.getCollection("stops");
  const originStop = stopsCollection.findOne({ code: originCode });
  const destStop = stopsCollection.findOne({ code: destCode });

  if (!originStop) return res.status(404).json({ error: `Stop ${originCode} not found` });
  if (!destStop) return res.status(404).json({ error: `Stop ${destCode} not found` });

  const options = findTripOptions(originCode, destCode);

  res.set("Cache-Control", "public, s-maxage=60").json({
    origin: { id: String(originCode), name: originStop.name ?? String(originCode) },
    destination: { id: String(destCode), name: destStop.name ?? String(destCode) },
    options,
  });
};
