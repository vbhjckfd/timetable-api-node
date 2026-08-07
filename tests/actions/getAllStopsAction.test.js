import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeReqRes, makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import getAllStopsAction from "../../actions/getAllStopsAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStop = {
  code: 1001,
  name: "Central Stop",
  eng_name: "Central Stop EN",
  location: { coordinates: [49.845, 24.023] },
  transfers: [{ route: "А01" }, { route: "Т1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getCollection.mockReturnValue(makeChainableCollection([mockStop]));
});

describe("getAllStopsAction", () => {
  it("returns JSON array for .json path", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops.json" });
    await getAllStopsAction(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          code: 1001,
          name: "Central Stop",
          eng_name: "Central Stop EN",
          location: [49.845, 24.023],
          routes: expect.arrayContaining(["А01", "Т1"]),
        }),
      ]),
    );
  });

  it("returns HTML table for non-json path", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops" });
    await getAllStopsAction(req, res, next);

    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("<table>"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("1001"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("Central Stop"),
    );
  });

  // /stop-overrides.js rewrites the row from these; without them the overrides
  // have nothing to attach to.
  it("marks up each row for the override script", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops" });
    await getAllStopsAction(req, res, next);

    const html = res.send.mock.calls[0][0];
    expect(html).toContain('<tr data-code="1001">');
    expect(html).toContain('data-routes="А01 Т1"');
    expect(html).toContain('<span class="route kept" data-route="А01">А01</span>');
    expect(html).toContain('data-kind="svg"');
    expect(html).toContain('data-kind="pdf"');
    expect(html).toContain('src="/stop-overrides.js"');
  });

  it("styles removed routes red and struck through, added ones green", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops" });
    await getAllStopsAction(req, res, next);

    const html = res.send.mock.calls[0][0];
    expect(html).toContain(".route.removed { color: red; text-decoration: line-through; }");
    expect(html).toContain(".route.added { color: green; }");
  });

  it("serves the bare upstream route list, so the page stays cacheable", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops" });
    await getAllStopsAction(req, res, next);

    const html = res.send.mock.calls[0][0];
    expect(html).not.toContain('class="route removed"');
    expect(html).not.toContain('class="route added"');
  });

  it("sets cache headers for Cloudflare", async () => {
    const { req, res, next } = makeReqRes({ path: "/stops.json" });
    await getAllStopsAction(req, res, next);

    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=0, s-maxage=2592000",
    );
    expect(res.set).toHaveBeenCalledWith("Cache-Tag", "short");
  });
});
