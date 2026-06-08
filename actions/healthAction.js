import { getArrivalTimes } from "../services/microgizService.js";

// Lviv transit operates roughly 06:00–23:00 local time
const TRANSIT_START_HOUR = 6;
const TRANSIT_END_HOUR = 23;

function lvivHour() {
  return parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "Europe/Kiev",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
}

export default async (req, res) => {
  const hour = lvivHour();
  if (hour < TRANSIT_START_HOUR || hour >= TRANSIT_END_HOUR) {
    return res.json({ status: "ok", note: "off_hours" });
  }

  try {
    const entities = await getArrivalTimes();
    if (!entities || entities.length === 0) {
      return res.status(503).json({ status: "degraded", trips: 0 });
    }
    return res.json({ status: "ok", trips: entities.length });
  } catch (e) {
    return res.status(503).json({ status: "error", message: e.message });
  }
};
