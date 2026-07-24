import localDb from "../connections/timetableSqliteDb.js";

// Liveness check: confirm the process is up and the embedded DB is loaded.
// Deliberately does not call out to the upstream GTFS-RT feed — that feed's
// own health is orthogonal to this service's liveness, and probing it on
// every check (Docker HEALTHCHECK every 60s, plus any external uptime
// monitor) burned real requests against our gtfs-eta worker for no benefit.
export default async (req, res) => {
  try {
    const ready = localDb.collections.length > 0;
    if (!ready) return res.status(503).json({ status: "error", message: "db not loaded" });
    return res.json({ status: "ok" });
  } catch (e) {
    return res.status(503).json({ status: "error", message: e.message });
  }
};
