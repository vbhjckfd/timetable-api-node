import { describe, expect, it } from "vitest";
import { activeDisruptions, kyivDate, parseDisruptions } from "../../services/disruptionService.js";
import raw from "../../data/disruptions.json" with { type: "json" };

const entry = (over = {}) => ({
  id: "test",
  kind: "detour",
  reason: "Ремонт",
  since: "2026-10-01",
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
