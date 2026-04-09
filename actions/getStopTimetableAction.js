import stopArrivalService from "../services/stopArrivalService.js";
import db from "../connections/timetableSqliteDb.js";

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
};
