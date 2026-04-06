import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import getStopStaticDataAction from "../../actions/getStopStaticDataAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStop = {
  code: 1001,
  name: "Static Stop",
  eng_name: "Static Stop EN",
  location: { coordinates: [49.845, 24.023] },
  transfers: [{ _id: "xyz", route: "А01", color: "#aaa", vehicle_type: "bus" }],
};

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getStopStaticDataAction", () => {
  it("returns 400 when code is not a number", async () => {
    const req = { params: { code: "bad" } };
    const res = makeRes();
    await getStopStaticDataAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when stop does not exist", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
    });

    const req = { params: { code: "9999" } };
    const res = makeRes();
    await getStopStaticDataAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns stop data without _id in transfers", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopStaticDataAction(req, res, vi.fn());

    const payload = res.json.mock.calls[0][0];
    expect(payload).toMatchObject({
      code: 1001,
      name: "Static Stop",
      eng_name: "Static Stop EN",
      latitude: 49.845,
      longitude: 24.023,
    });
    expect(payload.transfers[0]).not.toHaveProperty("_id");
    expect(payload.transfers[0].route).toBe("А01");
  });

  it("sets a long-lived cache-control header", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopStaticDataAction(req, res, vi.fn());

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage="),
    );
  });
});
