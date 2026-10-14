import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import type Loki from "lokijs";
import { Agent } from "undici";
import {
  getRouteColor,
  formatRouteName,
  getRouteType,
} from "../utils/appHelpers.ts";
import type { RouteDoc, StopDoc, Transfer } from "../types/domain.ts";

export type FeedEntity = transit_realtime.IFeedEntity;

/**
 * An entity of the vehicle_position feed. Every reader relies on the feed
 * carrying trip, vehicle and position on each entity; protobufjs decodes an
 * unset string field as "", so the ids and plate are always strings.
 */
export type VehicleEntity = FeedEntity & {
  vehicle: transit_realtime.IVehiclePosition & {
    trip: transit_realtime.ITripDescriptor & { tripId: string; routeId: string };
    vehicle: transit_realtime.IVehicleDescriptor & { id: string; licensePlate: string };
    position: transit_realtime.IPosition;
  };
};

class TruncatedResponseError extends Error {
  override name = "TruncatedResponseError";
}

class FeedDecodeError extends Error {
  override name = "FeedDecodeError";
}

async function fetchPlus(url: string, options: RequestInit = {}, retries: number): Promise<Response> {
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
// The feeds come from Cloudflare in front of an R2 bucket in Eastern Europe,
// while this service runs in us-central1, so a fresh TLS connection costs
// several transatlantic round trips. Node's default agent drops idle sockets
// after 4s, shorter than the gap between feed downloads; keep them for 30s.
const feedDispatcher = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000 });

async function fetchBytes(url: string, options: RequestInit = {}, retries: number): Promise<Uint8Array> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      dispatcher: feedDispatcher,
      ...options,
    } as RequestInit);
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
function decodeFeed(bytes: Uint8Array, url: string): FeedEntity[] {
  try {
    // A FeedMessage always decodes with an entity list, empty or not.
    return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(bytes).entity as FeedEntity[];
  } catch (error) {
    throw new FeedDecodeError(
      `Failed to decode GTFS-realtime feed (${bytes.byteLength} bytes) from ${url}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

async function withBackoff<T>(fn: () => Promise<T>, retries = 4, baseDelayMs = 200): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
}

export async function getTimeOfLastStaticUpdate(): Promise<Date> {
  const response = await fetchPlus("https://track.ua-gis.com/gtfs/lviv/static.zip", { method: "HEAD" }, 3);
  return new Date(response.headers.get("last-modified")!);
}

// Last good vehicle feed, used as a fallback when the upstream is briefly
// unavailable. Positions go stale fast, so we only serve it for a short window.
const VEHICLES_STALE_MAX_AGE_MS = 3 * 60 * 1000;
interface FeedCache<T> {
  entities: T[];
  at: number;
}

let vehiclesCache: FeedCache<VehicleEntity> | null = null;
let vehiclesInFlight: Promise<VehicleEntity[]> | null = null;

// Both feeds move about every 10s upstream, yet every request used to download
// them afresh: New Relic showed one feed fetch per API request, 80-300ms each
// and most of the timetable/transport response time. So requests no longer
// wait for a download at all while a recent copy exists:
// - younger than FEED_FRESH_MS: served as is;
// - younger than FEED_SERVE_STALE_MS: served as is, and a refresh starts in
//   the background (one at a time) for the next request;
// - older, or nothing yet: the request waits for the download, shared with
//   any other request already waiting.
// Refreshing on traffic rather than on a timer is deliberate: Cloud Run
// throttles CPU between requests, so a timer would stall exactly when idle.
// Callers already treat the entities as shared (see stopArrivalService),
// since the stale fallback in the loaders hands out the same objects.
const FEED_FRESH_MS = 5_000;
const FEED_SERVE_STALE_MS = 15_000;

function reuseOrLoad<T>(
  cache: FeedCache<T> | null,
  inFlight: Promise<T[]> | null,
  load: () => Promise<T[]>,
  setInFlight: (p: Promise<T[]> | null) => void,
): Promise<T[]> {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < FEED_FRESH_MS) return Promise.resolve(cache.entities);

  let p = inFlight;
  if (!p) {
    p = load().finally(() => setInFlight(null));
    setInFlight(p);
  }
  if (cache && age < FEED_SERVE_STALE_MS) {
    // The loaders log their own failures; nobody awaits this one.
    p.catch(() => {});
    return Promise.resolve(cache.entities);
  }
  return p;
}

// Test seam: drop the in-memory fallback so cases stay isolated.
export function __resetVehiclesCache(): void {
  vehiclesCache = null;
  vehiclesInFlight = null;
}

export function getVehiclesLocations(): Promise<VehicleEntity[]> {
  return reuseOrLoad(vehiclesCache, vehiclesInFlight, loadVehiclesLocations, (p) => {
    vehiclesInFlight = p;
  });
}

async function loadVehiclesLocations(): Promise<VehicleEntity[]> {
  const url =
    process.env.VEHICLES_LOCATION_URL || "https://track.ua-gis.com/gtfs/lviv/vehicle_position";
  try {
    const entities = await withBackoff(async () => {
      const data = await fetchBytes(url, {}, 3);
      return decodeFeed(data, url) as VehicleEntity[];
    });
    vehiclesCache = { entities, at: Date.now() };
    return entities;
  } catch (err) {
    if (vehiclesCache && Date.now() - vehiclesCache.at <= VEHICLES_STALE_MAX_AGE_MS) {
      const ageMs = Date.now() - vehiclesCache.at;
      console.warn(
        `getVehiclesLocations failed, serving cached feed (${Math.round(ageMs / 1000)}s old): ${(err as Error).message}`,
      );
      return vehiclesCache.entities;
    }
    throw err;
  }
}

// Last good arrival feed. Arrivals carry absolute timestamps and callers drop
// the ones already in the past, so a slightly stale feed degrades to "fewer
// arrivals" rather than wrong ones — but it still thins out fast, hence a
// window much shorter than the position feed's.
const ARRIVALS_STALE_MAX_AGE_MS = 60 * 1000;
let arrivalsCache: FeedCache<FeedEntity> | null = null;
let arrivalsInFlight: Promise<FeedEntity[]> | null = null;

// Test seam: drop the in-memory fallback so cases stay isolated.
export function __resetArrivalsCache(): void {
  arrivalsCache = null;
  arrivalsInFlight = null;
}

export function getArrivalTimes(): Promise<FeedEntity[]> {
  return reuseOrLoad(arrivalsCache, arrivalsInFlight, loadArrivalTimes, (p) => {
    arrivalsInFlight = p;
  });
}

async function loadArrivalTimes(): Promise<FeedEntity[]> {
  // trip_updates is served from our own gtfs-eta worker (R2-cached,
  // max-age=10), so the full backoff ladder used for the upstream position
  // feed would fan request volume out to the worker on every error. One
  // retry is the compromise: it covers the common blip — a body cut
  // mid-stream, which HTTP 200s and surfaces only as a Content-Length
  // mismatch or a decode error — without turning a worker hiccup into a
  // stampede. Arrivals are the whole response for /stops/:code/timetable, so
  // a single unretried failure blanks every stop at once.
  const url =
    process.env.TRIP_UDPDATES_URL || "https://track.ua-gis.com/gtfs/lviv/trip_updates";
  try {
    const entities = await withBackoff(
      async () => decodeFeed(await fetchBytes(url, {}, 0), url),
      1,
      100,
    );
    arrivalsCache = { entities, at: Date.now() };
    return entities;
  } catch (err) {
    if (arrivalsCache && Date.now() - arrivalsCache.at <= ARRIVALS_STALE_MAX_AGE_MS) {
      const ageMs = Date.now() - arrivalsCache.at;
      console.warn(
        `getArrivalTimes failed, serving cached feed (${Math.round(ageMs / 1000)}s old): ${(err as Error).message}`,
      );
      return arrivalsCache.entities;
    }
    throw err;
  }
}
export async function routesThroughStop(
  stop: Pick<StopDoc, "code">,
  routesCollection: Loki.Collection<RouteDoc>,
  stopsCollection: Loki.Collection<StopDoc>,
): Promise<Transfer[]> {
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
    .map((r): Transfer => {
      const directionId = Object.entries(r.stops_by_shape).find(
        ([, i]) => -1 !== i.slice(0, -1).indexOf(stop.code),
      )?.[0];
      const lastStopCode = r.stops_by_shape[directionId!].at(-1)!;
      const shapeId = Object.entries(r.shape_direction_map).find(
        ([, d]) => String(d) === directionId,
      )?.[0];

      return {
        id: r.external_id,
        color: getRouteColor(r.short_name),
        route: formatRouteName(r.short_name),
        vehicle_type: getRouteType(r.short_name),
        shape_id: shapeId,
        direction_id: Number(directionId),
        end_stop_name: stopsCollection.findOne({ code: lastStopCode })!.name,
        end_stop_eng_name: stopsCollection.findOne({ code: lastStopCode })!
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
