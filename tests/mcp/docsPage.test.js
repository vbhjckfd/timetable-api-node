import { describe, expect, it } from "vitest";

import { renderMcpDocsPage, wantsHtmlDocs } from "../../mcp/docsPage.js";

describe("wantsHtmlDocs", () => {
  it("serves the page to a browser", () => {
    expect(
      wantsHtmlDocs(
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ),
    ).toBe(true);
  });

  it("leaves an SSE probe from an MCP client to the 405", () => {
    expect(wantsHtmlDocs("text/event-stream")).toBe(false);
    expect(wantsHtmlDocs("application/json, text/event-stream")).toBe(false);
    expect(wantsHtmlDocs("text/html, text/event-stream")).toBe(false);
  });

  it("leaves requests without an HTML preference to the 405", () => {
    expect(wantsHtmlDocs(undefined)).toBe(false);
    expect(wantsHtmlDocs("")).toBe(false);
    expect(wantsHtmlDocs("*/*")).toBe(false);
    expect(wantsHtmlDocs("application/json")).toBe(false);
  });
});

describe("renderMcpDocsPage", () => {
  it("lists every registered tool with its arguments", async () => {
    const html = await renderMcpDocsPage("https://api.example.test/");

    for (const tool of [
      "get_stop_realtime",
      "get_route_static",
      "get_route_realtime",
      "get_stop_geometry",
      "get_stops_around_location",
      "get_nearby_vehicles",
      "get_vehicle_info",
    ]) {
      expect(html).toContain(`id="${tool}"`);
    }
    expect(html).toContain("<code>radius_meters</code> <span class=\"muted\">optional</span>");
    expect(html).toContain("<code>transit-map-view</code>");
  });

  it("points the connect snippets at the requesting host", async () => {
    const html = await renderMcpDocsPage("https://api.example.test");

    expect(html).toContain(
      "claude mcp add --transport http lviv-timetable https://api.example.test/mcp",
    );
    expect(html).toContain("https://api.example.test/.well-known/mcp/server-card.json");
  });

  it("escapes description text and keeps inline code readable", async () => {
    const html = await renderMcpDocsPage("https://api.example.test");

    expect(html).toContain("<code>get_stops_around_location</code>");
    expect(html).not.toMatch(/`get_stops_around_location`/);
  });
});
