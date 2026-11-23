import type { NextFunction, Request, Response } from "express";

// Some clients (the CityTransportGuide iOS app) send codes with a platform
// suffix, e.g. "0074-01". The numeric part is the stop code, so redirect to it.
const SUFFIXED_CODE = /^(\d+)-\d+$/;

export default function validateStopCode(req: Request, res: Response, next: NextFunction): void {
  const raw = String(req.params.code);
  const suffixed = SUFFIXED_CODE.exec(raw);
  if (suffixed && Number(suffixed[1])) {
    const target = req.originalUrl.replace(`/stops/${raw}`, `/stops/${Number(suffixed[1])}`);
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
