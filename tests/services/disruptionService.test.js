import { describe, expect, it } from "vitest";
import { activeDisruptions, kyivDate, parseDisruptions, servedFilter } from "../../services/disruptionService.js";
import raw from "../../data/disruptions.json" with { type: "json" };

const entry = (over = {}) => ({
  id: "test",
  kind: "detour",
  reason: "Ремонт",
  since: "2026-10-01",
  routes: ["А01"],
  ...over,
});

describe("data/disruptions.json", () => {
  it("parses, so a bad edit fails the test run instead of a deploy", () => {
    expect(() => parseDisruptions(raw)).not.toThrow();
  });
});

describe("parseDisruptions", () => {
  it("fills defaults and gives each route a display name and a URL id", () => {
    const [d] = parseDisruptions([entry({ routes: ["Т33", "A01"], alternatives: ["А34"] })]);
    expect(d.routes).toEqual([
      { name: "Т33", id: "T33" },
      { name: "А01", id: "A01" },
    ]);
    expect(d.alternatives).toEqual([{ name: "А34", id: "A34" }]);
    expect(d).toMatchObject({ until: null, stops: [], detour: null, note: null, url: null });
  });

  it("rejects duplicate ids, unknown kinds and an end before the start", () => {
    expect(() => parseDisruptions([entry(), entry()])).toThrow(/Duplicate/);
    expect(() => parseDisruptions([entry({ kind: "closure" })])).toThrow();
    expect(() => parseDisruptions([entry({ until: "2026-09-01" })])).toThrow(/ends before/);
    expect(() => parseDisruptions([entry({ since: "1 Oct" })])).toThrow();
  });

  it("rejects an entry that names no route or stop, since no tool could ever attach it", () => {
    expect(() => parseDisruptions([entry({ routes: [] })])).toThrow(/names no route or stop/);
    expect(() => parseDisruptions([entry({ routes: [], stops: [707] })])).not.toThrow();
    expect(() =>
      parseDisruptions([entry({ routes: [], detour: { via: ["вул. X"], skipped_stops: [808] } })]),
    ).not.toThrow();
  });
});

describe("activeDisruptions", () => {
  const entries = parseDisruptions([
    entry({ id: "open", routes: ["А34"] }),
    entry({ id: "ended", until: "2026-10-10", routes: ["А12"] }),
    entry({ id: "future", since: "2026-11-01", routes: ["А34"] }),
    entry({ id: "stop", kind: "stop_moved", stops: [707] }),
    entry({ id: "skip", detour: { via: ["вул. X"], skipped_stops: [808] } }),
  ]);
  const at = (iso) => new Date(iso);
  const ids = (list) => list.map((d) => d.id);

  it("keeps entries from their first through their last day, Kyiv time", () => {
    const today = at("2026-10-23T10:00:00Z");
    expect(ids(activeDisruptions(undefined, today, entries))).toEqual(["open", "stop", "skip"]);
    // 22:30 UTC on 10 Oct is already 11 Oct in Kyiv: the ended entry is gone.
    expect(ids(activeDisruptions(undefined, at("2026-10-10T22:30:00Z"), entries))).not.toContain("ended");
    expect(ids(activeDisruptions(undefined, at("2026-10-10T20:00:00Z"), entries))).toContain("ended");
  });

  it("filters by route in either alphabet, and by stop or skipped stop", () => {
    const today = at("2026-10-23T10:00:00Z");
    expect(ids(activeDisruptions({ routes: ["A34"] }, today, entries))).toEqual(["open"]);
    expect(ids(activeDisruptions({ routes: ["А34"] }, today, entries))).toEqual(["open"]);
    expect(ids(activeDisruptions({ stops: [707] }, today, entries))).toEqual(["stop"]);
    expect(ids(activeDisruptions({ stops: [808] }, today, entries))).toEqual(["skip"]);
    expect(activeDisruptions({}, today, entries)).toEqual([]);
  });

  it("formats today's date in Kyiv", () => {
    expect(kyivDate(at("2026-10-23T22:30:00Z"))).toBe("2026-10-24");
  });
});

describe("servedFilter", () => {
  const entries = parseDisruptions([
    entry({ id: "off", kind: "suspended", routes: ["Т33"] }),
    entry({ id: "skip", kind: "detour", routes: ["А12"], detour: { via: ["вул. X"], skipped_stops: [808] } }),
    entry({ id: "closed", kind: "stop_closed", routes: [], stops: [909] }),
    entry({ id: "closed-a34", kind: "stop_closed", routes: ["А34"], stops: [606] }),
    entry({ id: "moved", kind: "stop_moved", routes: [], stops: [505] }),
    entry({ id: "later", kind: "suspended", since: "2026-11-01", routes: ["Т30"] }),
  ]);
  const served = servedFilter(new Date("2026-10-23T10:00:00Z"), entries);

  it("takes a suspended route out of service everywhere, in either alphabet", () => {
    expect(served("Т33", 1)).toBe(false);
    expect(served("T33", 1)).toBe(false);
    expect(served("Т30", 1)).toBe(true);
  });

  it("drops a detour's skipped stops for its own routes only", () => {
    expect(served("А12", 808)).toBe(false);
    expect(served("А12", 1)).toBe(true);
    expect(served("А34", 808)).toBe(true);
  });

  it("closes a stop to the routes listed, or to every route when none are", () => {
    expect(served("А01", 909)).toBe(false);
    expect(served("А34", 606)).toBe(false);
    expect(served("А01", 606)).toBe(true);
    // A moved stop is still served.
    expect(served("А01", 505)).toBe(true);
  });
});
