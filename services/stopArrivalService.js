import * as Sentry from "@sentry/node";
import { getTrips } from "gtfs";
import {
  formatRouteName,
  getRouteColor,
  getRouteType,
  getDirectionByTrip,
  cleanUpStopName,
  getTextWaitTime,
  isLowFloor,
} from "../utils/appHelpers.js";
import { getArrivalTimes, getVehiclesLocations } from "./microgizService.js";
import { getScheduledArrivalsForStop } from "./stopScheduleService.js";

import timetableDb from "../connections/timetableSqliteDb.js";

function emitPulseSignal(stop) {
  const url = process.env.PULSE_WORKER_URL ?? '';
  const secret = process.env.PULSE_SIGNAL_SECRET ?? '';
  if (!url || !secret) return;
  const [lat, lng] = stop.location?.coordinates ?? [];
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  fetch(`${url}/signal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({ lat, lng, code: stop.code ?? null }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

const stopArrivalService = {
  getTimetableForStop: async function (stop, { skipPulse = false } = {}) {
    const now = new Date();

    const allRoutesRaw = timetableDb.getCollection("routes").find({});

    // Arrivals come from trip_updates and are the core of the response; the
    // position feed is supplementary (map rendering only). A position-feed
    // failure must not zero out the arrivals, so it degrades to no positions
    // rather than rejecting the whole request.
    //
    // A trip_updates failure used to reject the whole call, which the action
    // turned into an empty list — the stop then looked exactly like "nothing is
    // coming". It now degrades the same way: no live arrivals, and the schedule
    // fallback below carries the response.
    const [closestVehiclesRaw, vehiclesLocationsRaw] = await Promise.all([
      getArrivalTimes().catch((e) => {
        Sentry.captureException(e);
        Sentry.metrics.count('stop_timetable.arrivals_unavailable', 1, { attributes: { stop: String(stop.code) } });
        return [];
      }),
      getVehiclesLocations().catch((e) => {
        Sentry.captureException(e);
        Sentry.metrics.count('stop_timetable.positions_unavailable', 1, { attributes: { stop: String(stop.code) } });
        return [];
      }),
    ]);

    const routesByRouteId = Object.fromEntries(allRoutesRaw.map((r) => [r.external_id, r]));

    const closestVehicles = closestVehiclesRaw
      .filter((entity) => {
        return entity.tripUpdate.stopTimeUpdate
          .map((stu) => stu.stopId)
          .includes(stop.microgiz_id);
      })
      .map((i) => i.tripUpdate)
      .map((i) => {
        i.stopTimeUpdate = i.stopTimeUpdate
          .filter((st) => st.stopId == stop.microgiz_id)
          .shift();
        return i;
      })
      .map((i) => {
        const time = i.stopTimeUpdate.arrival || i.stopTimeUpdate.departure;
        return {
          time: parseInt(`${time.time}000`),
          route_id: i.trip.routeId,
          trip_id: i.trip.tripId,
          vehicle: i.vehicle.id,
        };
      })
      .filter((i) => new Date(i.time) >= now)
      .sort((a, b) => a.time - b.time);

    const tripsRaw = await getTrips({
      trip_id: closestVehicles.map((v) => v.trip_id),
    });

    const trips = Object.fromEntries((tripsRaw ?? []).map((t) => [t.trip_id, t]));

    const vehiclesIds = closestVehicles.map((v) => v.vehicle);
    const vehiclesLocations = vehiclesLocationsRaw.filter((entity) =>
      vehiclesIds.includes(entity.vehicle.vehicle.id),
    );
    const result = closestVehicles.map((vh) => {
      let routeInfoRaw = stop.transfers.find((i) => i.id == vh.route_id);
      let routeInfo = {};
      if (routeInfoRaw) {
        const { _id, id, ...rest } = routeInfoRaw;
        routeInfo = rest;
      } else {
        const routeObj = routesByRouteId[vh.route_id];
        if (!routeObj) {
          return null;
        }
        console.error(
          `No binding for route ${formatRouteName(routeObj.short_name)} to stop ${stop.name} (${stop.code})`,
        );
        routeInfo = {
          color: getRouteColor(routeObj.short_name),
          route: formatRouteName(routeObj.short_name),
          vehicle_type: getRouteType(routeObj.short_name),
        };
      }

      // The position feed is fetched separately from trip_updates and is not
      // snapshot-consistent with it: a vehicle mid-stop routinely blinks out of
      // the position feed for a poll or two while still having a valid arrival
      // prediction. Position is only needed for map rendering, so a missing one
      // must not suppress the arrival itself.
      const vehicleLocation = vehiclesLocations.find(
        (entity) => entity.vehicle.vehicle.id == vh.vehicle,
      );
      let vehicleInfo;
      if (vehicleLocation) {
        const position = vehicleLocation.vehicle.position;
        vehicleInfo = {
          vehicle_id: vehicleLocation.vehicle.vehicle.id,
          location: [parseFloat(position.latitude.toFixed(5)), parseFloat(position.longitude.toFixed(5))],
          bearing: position.bearing,
        };
      } else {
        vehicleInfo = { vehicle_id: vh.vehicle };
      }

      const trip = trips[vh.trip_id];
      return {
        route_id: vh.route_id,
        direction: getDirectionByTrip(vh.trip_id, routesByRouteId[vh.route_id]),
        lowfloor: vehicleLocation
          ? isLowFloor(trip, vehicleLocation, routesByRouteId[vh.route_id])
          : false,
        end_stop:
          trip && trip.trip_headsign ? cleanUpStopName(trip.trip_headsign) : "",
        arrival_time: new Date(vh.time).toUTCString(),
        time_left: getTextWaitTime(vh.time),
        ...vehicleInfo,
        ...routeInfo,
      };
    });

    const liveTimetable = result.filter((i) => !!i);

    // No live prediction does not mean nothing is coming: the feed only covers
    // each vehicle's next few stops, so an outer stop goes blank between the
    // moments a vehicle is close enough to be predicted. Falling back to the
    // published schedule keeps the stop answering the rider's actual question
    // instead of showing an empty page mid-service.
    const timetable = liveTimetable.length
      ? liveTimetable
      : getScheduledArrivalsForStop(stop, routesByRouteId, { now });

    // arrivals_count stays the *live* count so the schedule fallback cannot
    // paper over a feed-side regression in the dashboards; schedule_fallback
    // is what the rider was served instead.
    Sentry.metrics.count('stop_timetable.request', 1, { attributes: { stop: String(stop.code) } });
    Sentry.metrics.distribution('stop_timetable.arrivals_count', liveTimetable.length, { attributes: { stop: String(stop.code) } });
    const arrivalsWithoutPosition = liveTimetable.filter((i) => !i.location).length;
    if (arrivalsWithoutPosition > 0) {
      Sentry.metrics.count('stop_timetable.arrival_without_position', arrivalsWithoutPosition, { attributes: { stop: String(stop.code) } });
    }
    if (liveTimetable.length === 0) {
      Sentry.metrics.count('stop_timetable.empty', 1, { attributes: { stop: String(stop.code) } });
      Sentry.metrics.distribution('stop_timetable.schedule_fallback', timetable.length, { attributes: { stop: String(stop.code) } });
    }

    if (!skipPulse) emitPulseSignal(stop);

    return timetable;
  },
};

export default stopArrivalService;
