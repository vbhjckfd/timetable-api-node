import { distanceMeters } from "../utils/appHelpers.js";
import db from "../connections/timetableSqliteDb.js";

export default async (req, res, next) => {
  const longCacheAgeSeconds = 30 * 24 * 3600;
  const stopsCollection = db.getCollection("stops");

  const latitude = parseFloat(req.query.latitude);
  const longitude = parseFloat(req.query.longitude);
  const rawRadius = parseFloat(req.query.radius);
  let radiusMeters = Number.isFinite(rawRadius) ? Math.round(rawRadius) : 1000;
  radiusMeters = Math.min(3000, Math.max(50, radiusMeters));

  if (
    !isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    res
      .status(400)
      .send(
        "Bad argument: latitude must be between -90 and 90, longitude between -180 and 180",
      );
    return;
  }

  const results = stopsCollection
    .find({})
    .map((s) => {
      const position = s.location.coordinates;
      const dist = distanceMeters(
        position[0],
        position[1],
        latitude,
        longitude,
      );
      return { ...s, _dist: dist };
    })
    .filter((s) => s._dist < radiusMeters)
    .sort((a, b) => a._dist - b._dist);

  let cacheLine = `public, max-age=0, s-maxage=${longCacheAgeSeconds}, stale-while-revalidate=15`;
  if (!results.length) {
    cacheLine = "no-cache"; // Do not cache if no stops around point
  }

  const response = res.set("Cache-Control", cacheLine);
  if (cacheLine !== "no-cache") {
    response.set("Cache-Tag", "long");
  }

  response.json(
    results.map((s) => {
      return {
        code: s.code,
        name: s.name,
        longitude: s.location.coordinates[1],
        latitude: s.location.coordinates[0],
        distance_meters: Math.round(s._dist),
      };
    }),
  );
};
