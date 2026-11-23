import type { NextFunction, Request, Response } from "express";

// Some clients (the CityTransportGuide iOS app) send codes with a platform
// suffix, e.g. "0074-01". The numeric part is the stop code, so redirect to it.
const SUFFIXED_CODE = /^(\d+)-\d+$/;

export default function validateStopCode(req: Request, res: Response, next: NextFunction): void {
  const raw = String(req.params.code);
  const suffixed = SUFFIXED_CODE.exec(raw);
  if (suffixed && Number(suffixed[1])) {
    // Only validated digits and the sub-path segments after the code go into
    // the Location header; the prefix is fixed, so it cannot point off-site.
    const subPath = req.path.split("/").slice(3).map(encodeURIComponent).join("/");
    const queryStart = req.originalUrl.indexOf("?");
    const query = queryStart === -1 ? "" : req.originalUrl.slice(queryStart);
    const target = `/stops/${Number(suffixed[1])}${subPath ? `/${subPath}` : ""}${query}`;
    res.redirect(301, target);
    return;
  }

  const code = Number(raw);
  if (!code) {
    res.status(400).send(`Bad argument, ${req.params.code} is not a number`);
    return;
  }
  req.stopCode = code;
  next();
}
