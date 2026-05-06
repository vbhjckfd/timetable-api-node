import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  getRouteColor,
  formatRouteName,
  getRouteType,
} from "../utils/appHelpers.js";

async function fetchPlus(url, options = {}, retries) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    if (res.ok) return res;
    if (retries > 0) return fetchPlus(url, options, retries - 1);
    throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    if (retries > 0) return fetchPlus(url, options, retries - 1);
    throw error;
  }
}

export async function getTimeOfLastStaticUpdate() {
  const response = await fetch("https://track.ua-gis.com/gtfs/lviv/static.zip", { method: "HEAD" });
  return new Date(response.headers.get("last-modified"));
}

export async function getVehiclesLocations() {
  const response = await fetchPlus(
    process.env.VEHICLES_LOCATION_URL || "https://track.ua-gis.com/gtfs/lviv/vehicle_position",
    {},
    3,
  );
  const data = await response.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(data)).entity;
}

export async function getArrivalTimes() {
  const response = await fetchPlus(
    process.env.TRIP_UDPDATES_URL || "https://track.ua-gis.com/gtfs/lviv/trip_updates",
    {},
    3,
  );
  const data = await response.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(data)).entity;
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
