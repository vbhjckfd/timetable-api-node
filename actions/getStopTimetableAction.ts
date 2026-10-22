import type { NextFunction, Request, Response } from "express";
import stopArrivalService from "../services/stopArrivalService.ts";
import type { LiveArrival, StopArrival } from "../services/stopArrivalService.ts";
import db from "../connections/timetableSqliteDb.ts";
import type { StopDoc } from "../types/domain.ts";

export default async (req: Request, res: Response, next: NextFunction) => {
  const code = req.stopCode;

  const stop = db.getCollection<StopDoc>("stops").findOne({ code: code });
  if (!stop) {
    res.status(404).send(`Bad argument, stop with code ${code} not found`);
    return;
  }

  let timetableData: (StopArrival | Omit<LiveArrival, "direction" | "shape_id">)[] = [];
  try {
    const skipPulse = req.headers?.['user-agent']?.startsWith('timetable-healthcheck');
    timetableData = await stopArrivalService.getTimetableForStop(stop, { skipPulse });

    timetableData = timetableData.map((i) => {
      const { direction, shape_id, ...rest } = i as LiveArrival;
      return rest;
    });
  } catch (e) {
    console.error(e);
  }
  const cacheAge = timetableData.length > 0 ? 10 : 5;

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${cacheAge}`)
    .set("Cache-Tag", "short")
    .json(timetableData);
};
