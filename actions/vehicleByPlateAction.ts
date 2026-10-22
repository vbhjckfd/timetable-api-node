import type { Request, Response } from "express";
import * as metrics from "../utils/metrics.ts";
import { getVehiclesLocations } from "../services/microgizService.ts";

function normalizePlate(plate: string): string {
  return plate.replace(/[\s-]/g, "").toUpperCase();
}

export { normalizePlate };

export default async (req: Request<{ plate: string }>, res: Response) => {
  metrics.count('vehicle_lookup.by_plate', 1);
  const plate = normalizePlate(req.params.plate);
  const entities = await getVehiclesLocations();

  const match = entities.find(
    (e) => normalizePlate(e.vehicle?.vehicle?.licensePlate ?? "") === plate,
  );

  if (!match) return res.sendStatus(404);

  res
    .set("Cache-Control", "public, s-maxage=5")
    .set("Cache-Tag", "short")
    .send({ vehicleId: match.vehicle.vehicle.id });
};
