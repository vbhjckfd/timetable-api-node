import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import fetch from "node-fetch";
import _ from 'lodash';
import { getRouteColor, formatRouteName, getRouteType } from "../utils/appHelpers.js";

const fetchPlus = (url, options = {}, retries) =>
    fetch(url, options)
      .then(res => {
        if (res.ok) {
          return res
        }
        if (retries > 0) {
          return fetchPlus(url, options, retries - 1)
        }
        throw new Error(res.status)
      })
      .catch(error => console.error(error.message))

export function getTimeOfLastStaticUpdate() {
    return fetch('http://track.ua-gis.com/gtfs/lviv/static.zip', {
        method: 'HEAD'
    }).then(response => {
        return new Date(response.headers.get('last-modified'));
    });
}
export function getVehiclesLocations() {
    return fetchPlus(
        process.env.VEHICLES_LOCATION_URL || 'http://track.ua-gis.com/gtfs/lviv/vehicle_position',
        {},
        3
    )
        .then(response => response.buffer())
        .then(data => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity);
}
export function getArrivalTimes() {
    return fetchPlus(
        process.env.TRIP_UDPDATES_URL || 'http://track.ua-gis.com/gtfs/lviv/trip_updates',
        {},
        3
    )
        .then(response => response.buffer())
        .then(data => GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(data).entity);
}
export async function routesThroughStop(stop, routesCollection, stopsCollection) {
    const transfers = routesCollection
        .find({})
        .filter(r => {
            for (const key of ["0", "1"]) {
                if (-1 !== r.stops_by_shape[key].slice(0, -1).indexOf(stop.code)) {
                    return true;
                }
            }

            return false;
        })
        .map(r => {
            const directionId = _(r.stops_by_shape).findKey(i => -1 !== i.slice(0, -1).indexOf(stop.code));
            const lastStopCode = _(r.stops_by_shape[directionId]).last();
            const shapeId = _(r.shape_direction_map).findKey(d => d == directionId);

            return {
                id: r.external_id,
                color: getRouteColor(r.short_name),
                route: formatRouteName(r.short_name),
                vehicle_type: getRouteType(r.short_name),
                shape_id: shapeId,
                direction_id: Number(directionId),
                end_stop_name: stopsCollection.findOne({ code: lastStopCode }).name,
                end_stop_eng_name: stopsCollection.findOne({ code: lastStopCode }).eng_name,
                end_stop_code: lastStopCode
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