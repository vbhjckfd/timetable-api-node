import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/stopArrivalService.js", () => ({
  default: { getTimetableForStop: vi.fn() },
}));

import getStopTimetableAction from "../../actions/getStopTimetableAction.js";
import db from "../../connections/timetableSqliteDb.js";
import stopArrivalService from "../../services/stopArrivalService.js";

const mockStop = {
  code: 1001,
  name: "Timetable Stop",
  microgiz_id: "MG1001",
  transfers: [],
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

describe("getStopTimetableAction", () => {
  it("returns 400 for non-numeric code", async () => {
    const req = { params: { code: "abc" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when stop is not found", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
    });

    const req = { params: { code: "9999" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns timetable data for a valid stop", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockResolvedValue([
      { route: "А01", direction: 0, shape_id: "S1", arrival_time: "soon" },
    ]);

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    const payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toHaveProperty("route", "А01");
    // direction and shape_id should be stripped
    expect(payload[0]).not.toHaveProperty("direction");
    expect(payload[0]).not.toHaveProperty("shape_id");
  });

  it("returns empty array when service throws", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockRejectedValue(
      new Error("timeout"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("sets a short cache-control when timetable is empty", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockResolvedValue([]);

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage=5"),
    );
  });

  it("sets a longer cache-control when timetable has entries", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockResolvedValue([
      { route: "А01", direction: 0, shape_id: "S1" },
    ]);

    const req = { params: { code: "1001" } };
    const res = makeRes();
    await getStopTimetableAction(req, res, vi.fn());

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage=10"),
    );
  });
});
