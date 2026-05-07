import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/microgizService.js", () => ({
  getVehiclesLocations: vi.fn(),
}));

import vehicleByPlateAction, {
  normalizePlate,
} from "../../actions/vehicleByPlateAction.js";
import { getVehiclesLocations } from "../../services/microgizService.js";

function makeEntity(id, licensePlate) {
  return { vehicle: { vehicle: { id, licensePlate } } };
}

function makeRes() {
  return {
    sendStatus: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("normalizePlate", () => {
  it.each([
    ["BC-1234-AA", "BC1234AA"],
    ["bc1234 aa", "BC1234AA"],
    ["bc 1234 aa", "BC1234AA"],
    ["bc1234aa", "BC1234AA"],
    ["BC 1234 AA", "BC1234AA"],
    ["BC-1234AA", "BC1234AA"],
  ])('normalizes "%s" to "%s"', (input, expected) => {
    expect(normalizePlate(input)).toBe(expected);
  });
});

describe("vehicleByPlateAction", () => {
  it("returns 404 when no vehicle matches", async () => {
    getVehiclesLocations.mockResolvedValue([makeEntity("VH1", "BC-0000-ZZ")]);

    const res = makeRes();
    await vehicleByPlateAction({ params: { plate: "BC-9999-AA" } }, res);

    expect(res.sendStatus).toHaveBeenCalledWith(404);
  });

  it("finds vehicle by exact plate", async () => {
    getVehiclesLocations.mockResolvedValue([makeEntity("VH42", "BC-1234-AA")]);

    const res = makeRes();
    await vehicleByPlateAction({ params: { plate: "BC-1234-AA" } }, res);

    expect(res.send).toHaveBeenCalledWith({ vehicleId: "VH42" });
  });

  it("matches plate ignoring dashes and spaces", async () => {
    getVehiclesLocations.mockResolvedValue([makeEntity("VH42", "BC-1234-AA")]);

    const res = makeRes();
    await vehicleByPlateAction({ params: { plate: "bc 1234 aa" } }, res);

    expect(res.send).toHaveBeenCalledWith({ vehicleId: "VH42" });
  });

  it("matches when stored plate has no separators", async () => {
    getVehiclesLocations.mockResolvedValue([makeEntity("VH42", "BC1234AA")]);

    const res = makeRes();
    await vehicleByPlateAction({ params: { plate: "BC-1234-AA" } }, res);

    expect(res.send).toHaveBeenCalledWith({ vehicleId: "VH42" });
  });
});
