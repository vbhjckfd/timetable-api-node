import type { Request, Response } from "express";
import { activeDisruptions } from "../services/disruptionService.ts";

/**
 * Announced closures, detours and moved stops in force today, optionally only
 * those touching `?route=` or `?stop=`.
 *
 * The list ships with the image, so it is tagged "long" like the docs: only a
 * code-push build changes it. The short TTL is for the date filter, so an
 * entry appears and expires on its own day.
 */
export default (req: Request, res: Response) => {
  const route = typeof req.query.route === "string" ? req.query.route.trim() : "";
  const stop = typeof req.query.stop === "string" ? req.query.stop.trim() : "";

  if (stop && !/^\d+$/.test(stop)) {
    res.status(400).send("Bad argument, stop must be a numeric stop code");
    return;
  }

  const filtered = route || stop;
  const disruptions = activeDisruptions(
    filtered ? { routes: route ? [route] : [], stops: stop ? [Number(stop)] : [] } : undefined,
  );

  res
    .set("Cache-Control", `public, max-age=0, s-maxage=${5 * 60}`)
    .set("Cache-Tag", "long")
    .json({ disruptions, updated_at: new Date().toISOString() });
};
