import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  getRouteColor,
  formatRouteName,
  getRouteType,
} from "../utils/appHelpers.js";

class TruncatedResponseError extends Error {
  name = "TruncatedResponseError";
}

class FeedDecodeError extends Error {
  name = "FeedDecodeError";
}

async function fetchPlus(url, options = {}, retries) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    if (res.ok) return res;
    if (retries > 0) return fetchPlus(url, options, retries - 1);
    throw new Error(`HTTP ${res.status} ${url}`);
  } catch (error) {
    if (retries > 0) return fetchPlus(url, options, retries - 1);
    throw error;
  }
}

// Fetches a binary body and verifies it against Content-Length. A short body
// returned with HTTP 200 (e.g. a connection cut mid-stream) would otherwise
// pass res.ok and feed a truncated buffer to the protobuf decoder. Throwing
// here instead lets the retry path re-fetch a fresh, complete payload.
async function fetchBytes(url, options = {}, retries) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    if (res.ok) {
      const data = new Uint8Array(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length"));
      if (expected && data.byteLength !== expected) {
        throw new TruncatedResponseError(
          `Truncated response: got ${data.byteLength} of ${expected} bytes ${url}`,
        );
      }
      return data;
    }
    if (retries > 0) return fetchBytes(url, options, retries - 1);
    throw new Error(`HTTP ${res.status} ${url}`);
  } catch (error) {
    if (retries > 0) return fetchBytes(url, options, retries - 1);
    throw error;
  }
}

// Decodes a GTFS-realtime FeedMessage, tagging decode failures so logs can
// tell "upstream sent undecodable bytes" apart from network/retry errors.
function decodeFeed(bytes, url) {
  try {
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes).entity;
  } catch (error) {
    throw new FeedDecodeError(
      `Failed to decode GTFS-realtime feed (${bytes.byteLength} bytes) from ${url}: ${error.message}`,
      { cause: error },
    );
  }
}

async function withBackoff(fn, retries = 4, baseDelayMs = 200) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
}

export async function getTimeOfLastStaticUpdate() {
  const response = await fetchPlus("https://track.ua-gis.com/gtfs/lviv/static.zip", { method: "HEAD" }, 3);
  return new Date(response.headers.get("last-modified"));
}

// Last good vehicle feed, used as a fallback when the upstream is briefly
// unavailable. Positions go stale fast, so we only serve it for a short window.
const VEHICLES_STALE_MAX_AGE_MS = 3 * 60 * 1000;
let vehiclesCache = null; // { entities, at }

// Test seam: drop the in-memory fallback so cases stay isolated.
export function __resetVehiclesCache() {
  vehiclesCache = null;
}

export async function getVehiclesLocations() {
  const url =
    process.env.VEHICLES_LOCATION_URL || "https://track.ua-gis.com/gtfs/lviv/vehicle_position";
  try {
    const entities = await withBackoff(async () => {
      const data = await fetchBytes(url, {}, 3);
      return decodeFeed(data, url);
    });
    vehiclesCache = { entities, at: Date.now() };
    return entities;
  } catch (err) {
    if (vehiclesCache && Date.now() - vehiclesCache.at <= VEHICLES_STALE_MAX_AGE_MS) {
      const ageMs = Date.now() - vehiclesCache.at;
      console.warn(
        `getVehiclesLocations failed, serving cached feed (${Math.round(ageMs / 1000)}s old): ${err.message}`,
      );
      return vehiclesCache.entities;
    }
    throw err;
  }
}

export async function getArrivalTimes() {
  // No backoff here: trip_updates is served from our own gtfs-eta worker
  // (R2-cached, max-age=10). Retrying it fans out request volume to the
  // worker on every error. A single fetch is enough; backoff stays only on
  // getVehiclesLocations, which hits the upstream track.ua-gis.com feed.
  const url =
    process.env.TRIP_UDPDATES_URL || "https://track.ua-gis.com/gtfs/lviv/trip_updates";
  const data = await fetchBytes(url, {}, 0);
  return decodeFeed(data, url);
}
export async function routesThroughStop(
  stop,
  routesCollection,
  stopsCollection,
) {
  const transfers = routesCollection
    .find({})
    .filter((r) => {
      for (const key of ["0", "1"]) {
        if (-1 !== r.stops_by_shape[key].slice(0, -1).indexOf(stop.code)) {
          return true;
        }
      }

      return false;
    })
    .map((r) => {
      const directionId = Object.entries(r.stops_by_shape).find(
        ([, i]) => -1 !== i.slice(0, -1).indexOf(stop.code),
      )?.[0];
      const lastStopCode = r.stops_by_shape[directionId].at(-1);
      const shapeId = Object.entries(r.shape_direction_map).find(
        ([, d]) => d == directionId,
      )?.[0];

      return {
        id: r.external_id,
        color: getRouteColor(r.short_name),
        route: formatRouteName(r.short_name),
        vehicle_type: getRouteType(r.short_name),
        shape_id: shapeId,
        direction_id: Number(directionId),
        end_stop_name: stopsCollection.findOne({ code: lastStopCode }).name,
        end_stop_eng_name: stopsCollection.findOne({ code: lastStopCode })
          .eng_name,
        end_stop_code: lastStopCode,
      };
    })
    .sort((a, b) => {
      if (a.route < b.route) {
        return -1;
      }
      if (a.route > b.route) {
        return 1;
      }

      return 0;
    });

  return transfers;
}
