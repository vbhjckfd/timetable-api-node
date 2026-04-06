import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

vi.mock("../../services/stopArrivalService.js", () => ({
  default: { getTimetableForStop: vi.fn() },
}));

import getSingleStopAction from "../../actions/getSingleStopAction.js";
import db from "../../connections/timetableSqliteDb.js";
import stopArrivalService from "../../services/stopArrivalService.js";

const mockStop = {
  code: 1001,
  name: "Test Stop",
  eng_name: "Test Stop EN",
  location: { coordinates: [49.845, 24.023] },
  transfers: [{ _id: "abc", route: "А01", color: "#f00", vehicle_type: "bus" }],
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

describe("getSingleStopAction", () => {
  it("returns 400 when code param is not a valid number", async () => {
    const req = { params: { code: "notanumber" }, query: {} };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when stop is not found", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(null),
    });

    const req = { params: { code: "9999" }, query: {} };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns stop data with timetable on success", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockResolvedValue([
      { route: "А01", arrival_time: "Mon, 06 Apr 2026 10:00:00 GMT" },
    ]);

    const req = { params: { code: "1001" }, query: {} };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1001,
        name: "Test Stop",
        eng_name: "Test Stop EN",
        longitude: 24.023,
        latitude: 49.845,
        timetable: expect.arrayContaining([
          expect.objectContaining({ route: "А01" }),
        ]),
      }),
    );
  });

  it("strips _id from transfers", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockResolvedValue([]);

    const req = { params: { code: "1001" }, query: {} };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    const { transfers } = res.json.mock.calls[0][0];
    expect(transfers[0]).not.toHaveProperty("_id");
    expect(transfers[0]).toHaveProperty("route", "А01");
  });

  it("skips timetable fetch when skipTimetableData is set", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });

    const req = {
      params: { code: "1001" },
      query: { skipTimetableData: "true" },
    };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    expect(stopArrivalService.getTimetableForStop).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ timetable: [] }),
    );
  });

  it("returns empty timetable when TimetableService throws", async () => {
    db.getCollection.mockReturnValue({
      findOne: vi.fn().mockReturnValue(mockStop),
    });
    stopArrivalService.getTimetableForStop.mockRejectedValue(
      new Error("network error"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const req = { params: { code: "1001" }, query: {} };
    const res = makeRes();
    await getSingleStopAction(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ timetable: [] }),
    );
  });
});
