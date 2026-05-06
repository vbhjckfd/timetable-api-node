import stopArrivalService from "../services/stopArrivalService.js";
import db from "../connections/timetableSqliteDb.js";

const PULSE_WORKER_URL = process.env.PULSE_WORKER_URL ?? '';
const PULSE_SIGNAL_SECRET = process.env.PULSE_SIGNAL_SECRET ?? '';

function emitPulseSignal(stop) {
  if (!PULSE_WORKER_URL || !PULSE_SIGNAL_SECRET) return;
  const [lat, lng] = stop.location?.coordinates ?? [];
  if (typeof lat !== 'number' || typeof lng !== 'number') return;
  fetch(`${PULSE_WORKER_URL}/signal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PULSE_SIGNAL_SECRET}`,
    },
    body: JSON.stringify({ lat, lng, code: stop.code ?? null }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

export default async (req, res, next) => {
  const code = req.stopCode;

  const stop = db.getCollection("stops").findOne({ code: code });
  if (!stop) {
    res.status(404).send(`Bad argument, stop with code ${code} not found`);
    return;
  }

  let timetableData = [];
  try {
    timetableData = await stopArrivalService.getTimetableForStop(stop);

    timetableData = timetableData.map((i) => {
      const { direction, shape_id, ...rest } = i;
      return rest;
    });
  } catch (e) {
    console.error(e);
  }
  const cacheAge = timetableData.length > 0 ? 10 : 5;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${cacheAge}`)
    .json(timetableData);

  emitPulseSignal(stop);
};
