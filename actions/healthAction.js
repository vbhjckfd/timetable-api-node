import { getArrivalTimes } from "../services/microgizService.js";

// Liveness check: verify we can fetch + decode the GTFS-RT feed. An empty
// feed (0 entities) is normal when no vehicles are running (e.g. overnight)
// and is not a failure of this service, so it returns 200 with trips: 0.
export default async (req, res) => {
  try {
    const entities = await getArrivalTimes();
    return res.json({ status: "ok", trips: entities?.length ?? 0 });
  } catch (e) {
    return res.status(503).json({ status: "error", message: e.message });
  }
};
