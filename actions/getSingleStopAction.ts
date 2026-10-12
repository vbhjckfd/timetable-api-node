import type { NextFunction, Request, Response } from "express";
import stopArrivalService from "../services/stopArrivalService.ts";
import type { StopArrival } from "../services/stopArrivalService.ts";
import db from "../connections/timetableSqliteDb.ts";
import type { StopDoc } from "../types/domain.ts";

export default async (req: Request, res: Response, next: NextFunction) => {
  const code = req.stopCode;

  const stop = db.getCollection<StopDoc>("stops").findOne({ code: code });

  if (!stop) {
    res.status(404).send(`Bad argument, stop with code ${code} not found`);
    return;
  }

  const skipTimetableData =
    req.query.skipTimetableData === "true" ||
    req.query.skipTimetableData === "1";
  let timetableData: StopArrival[] = [];
  try {
    if (!skipTimetableData) {
      timetableData = await stopArrivalService.getTimetableForStop(stop);
    }
  } catch (e) {
    console.error(e);
  }
  const cacheAge = timetableData.length > 0 ? 10 : 5;

  const transfers = stop.transfers.map((i) => {
    const { _id, ...omitted } = i;
    return omitted;
  });

  res
    .set(
      "Cache-Control",
      `public, max-age=0, s-maxage=${skipTimetableData ? 10 * 24 * 3600 : cacheAge}`,
    )
    .json({
      name: stop.name,
      eng_name: stop.eng_name,
      longitude: stop.location.coordinates[1],
      latitude: stop.location.coordinates[0],
      transfers: transfers,
      code: stop.code,
      timetable: timetableData,
    });
};
