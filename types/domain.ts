/**
 * Shapes of the documents gtfs-import.ts writes into the loki Timetable file
 * (`routes` and `stops` collections), as every reader of that file sees them.
 */

export type VehicleType = "bus" | "tram" | "trolleybus";

/** [lat, lng] — the codebase's order throughout, despite the GeoJSON-looking `type: "Point"`. */
export type LatLng = [number, number];

/** Wall-clock "HH:MM" departure times per GTFS stop_id. */
export type DepartureTimeMap = Record<string, string[]>;

/** A route serving a stop, as stored on the stop. Built by routesThroughStop(). */
export interface Transfer {
  _id?: unknown;
  id: string;
  color: string;
  route: string;
  vehicle_type: VehicleType;
  shape_id: string | undefined;
  direction_id: number;
  end_stop_name: string;
  end_stop_eng_name: string;
  end_stop_code: number;
}

export interface StopDoc {
  code: number;
  name: string;
  eng_name: string;
  microgiz_id: string;
  location: {
    type: "Point";
    coordinates: LatLng;
  };
  transfers: Transfer[];
}

export interface RouteDoc {
  external_id: string;
  short_name: string;
  long_name: string | null;
  trip_shape_map: Record<string, string | null>;
  trip_direction_map: Record<string, number>;
  /** Stop codes per direction, keyed "0" and "1". */
  stops_by_shape: Record<string, number[]>;
  /** Polylines keyed by shape_id. */
  shapes: Record<string, LatLng[]>;
  shape_direction_map: Record<string, number>;
  stop_departure_time_map: DepartureTimeMap;
  stop_departure_time_map_workday?: DepartureTimeMap;
  stop_departure_time_map_weekend?: DepartureTimeMap;
  stop_departure_time_map_saturday?: DepartureTimeMap;
  stop_departure_time_map_sunday?: DepartureTimeMap;
  /** Directions whose polyline was synthesized from the stop sequence. */
  synthetic_shape_dirs?: number[];
}
