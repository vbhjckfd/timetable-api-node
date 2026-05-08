import * as Sentry from "@sentry/node";
import { getVehiclesLocations } from "../services/microgizService.js";

function normalizePlate(plate) {
  return plate.replace(/[\s-]/g, "").toUpperCase();
}

export { normalizePlate };

export default async (req, res) => {
  Sentry.metrics.count('vehicle_lookup.by_plate', 1);
  const plate = normalizePlate(req.params.plate);
  const entities = await getVehiclesLocations();

  const match = entities.find(
    (e) => normalizePlate(e.vehicle?.vehicle?.licensePlate ?? "") === plate,
  );

  if (!match) return res.sendStatus(404);

  res
    .set("Cache-Control", "public, s-maxage=5")
    .send({ vehicleId: match.vehicle.vehicle.id });
};
