import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeReqRes, makeChainableCollection } from "../helpers/mockHelpers.js";

vi.mock("../../connections/timetableSqliteDb.js", () => ({
  default: { getCollection: vi.fn() },
}));

import sitemapAction from "../../actions/sitemapAction.js";
import db from "../../connections/timetableSqliteDb.js";

const mockStops = [
  { code: 101, name: "Stop One" },
  { code: 202, name: "Stop Two" },
];

const mockRoutes = [
  { short_name: "А1" },
  { short_name: "Т5" },
  { short_name: "Тр20" },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.getCollection.mockImplementation((name) => {
    if (name === "stops") return makeChainableCollection(mockStops);
    if (name === "routes") return makeChainableCollection(mockRoutes);
  });
});

describe("sitemapAction", () => {
  it("sets Content-Type to application/xml", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "application/xml");
  });

  it("sets cache-control header", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    expect(res.set).toHaveBeenCalledWith(
      "Cache-Control",
      expect.stringContaining("s-maxage="),
    );
  });

  it("returns valid XML with urlset root", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    const xml = res.send.mock.calls[0][0];
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain("</urlset>");
  });

  it("includes a URL for each stop", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    const xml = res.send.mock.calls[0][0];
    expect(xml).toContain("/stops/101");
    expect(xml).toContain("/stops/202");
  });

  it("includes a URL for each route using latin names", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    const xml = res.send.mock.calls[0][0];
    expect(xml).toContain("/route/A01");
    expect(xml).toContain("/route/T05");
    expect(xml).toContain("/route/Tp20");
  });

  it("includes the homepage URL", () => {
    const { req, res } = makeReqRes();
    sitemapAction(req, res);
    const xml = res.send.mock.calls[0][0];
    expect(xml).toMatch(/<url><loc>https?:\/\/[^/]+\/<\/loc><\/url>/);
  });
});
