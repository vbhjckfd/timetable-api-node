import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  addRoute,
  applyOverride,
  isEmptyOverride,
  isValidRouteName,
  loadOverrides,
  normalizeOverride,
  overrideQuery,
  saveOverrides,
  signLinks,
  toggleRoute,
  MAX_ROUTES_PER_LIST,
  STORAGE_KEY,
} from "../../public/stopOverrides.js";

/** In-memory localStorage stand-in — no jsdom needed for two get/set calls. */
function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

const ROUTES = ["А03", "А05", "А55"];

describe("isValidRouteName", () => {
  it.each(["А03", "Т25", "32A", "Аеропорт", "5"])("accepts %s", (name) => {
    expect(isValidRouteName(name)).toBe(true);
  });

  it.each(["", "../etc", "A 47", "A,47", "a".repeat(17), 47, null])(
    "rejects %s",
    (name) => {
      expect(isValidRouteName(name)).toBe(false);
    },
  );
});

describe("normalizeOverride", () => {
  it("returns empty lists for a missing entry", () => {
    expect(normalizeOverride(undefined)).toEqual({ add: [], remove: [] });
  });

  it("drops names that are not route names", () => {
    expect(normalizeOverride({ add: ["Т03", "../etc"], remove: ["А57", ""] })).toEqual({
      add: ["Т03"],
      remove: ["А57"],
    });
  });

  it("dedupes", () => {
    expect(normalizeOverride({ add: ["Т03", "Т03"], remove: [] }).add).toEqual(["Т03"]);
  });

  it("lets remove win when a name is in both lists", () => {
    expect(normalizeOverride({ add: ["Т03"], remove: ["Т03"] })).toEqual({
      add: [],
      remove: ["Т03"],
    });
  });

  it("caps each list", () => {
    const many = Array.from({ length: MAX_ROUTES_PER_LIST + 5 }, (_, i) => `A${i}`);
    expect(normalizeOverride({ add: many }).add).toHaveLength(MAX_ROUTES_PER_LIST);
  });

  it("survives a non-array", () => {
    expect(normalizeOverride({ add: "Т03", remove: 7 })).toEqual({ add: [], remove: [] });
  });
});

describe("isEmptyOverride", () => {
  it("is true for an entry with nothing usable in it", () => {
    expect(isEmptyOverride({ add: ["../etc"], remove: [] })).toBe(true);
  });

  it("is false once a name survives", () => {
    expect(isEmptyOverride({ add: ["Т03"], remove: [] })).toBe(false);
  });
});

describe("overrideQuery", () => {
  it("is empty for no override", () => {
    expect(overrideQuery({ add: [], remove: [] })).toBe("");
  });

  it("emits add and remove", () => {
    expect(overrideQuery({ add: ["T02"], remove: ["T03"] })).toBe("add=T02&remove=T03");
  });

  it("percent-encodes Cyrillic names and keeps the comma literal", () => {
    expect(overrideQuery({ add: ["Т03", "А47"], remove: [] })).toBe(
      "add=%D0%A203,%D0%9047",
    );
  });

  it("omits the side that is empty", () => {
    expect(overrideQuery({ add: [], remove: ["T03"] })).toBe("remove=T03");
  });
});

describe("signLinks", () => {
  it("leaves the links bare when there is no override", () => {
    expect(signLinks(62, {})).toEqual({
      svg: "https://offline.lad.lviv.ua/62",
      pdf: "https://pdf.lad.lviv.ua/62.pdf",
    });
  });

  it("hangs the query off both links", () => {
    expect(signLinks(62, { add: ["T02"], remove: ["T03"] })).toEqual({
      svg: "https://offline.lad.lviv.ua/62?add=T02&remove=T03",
      pdf: "https://pdf.lad.lviv.ua/62.pdf?add=T02&remove=T03",
    });
  });
});

describe("applyOverride", () => {
  it("marks every upstream route kept when there is no override", () => {
    expect(applyOverride(ROUTES, {})).toEqual([
      { name: "А03", state: "kept" },
      { name: "А05", state: "kept" },
      { name: "А55", state: "kept" },
    ]);
  });

  it("marks a removed route rather than dropping it", () => {
    expect(applyOverride(ROUTES, { remove: ["А05"] })).toContainEqual({
      name: "А05",
      state: "removed",
    });
  });

  it("appends added routes after the upstream ones", () => {
    const result = applyOverride(ROUTES, { add: ["Т03"] });
    expect(result.at(-1)).toEqual({ name: "Т03", state: "added" });
  });

  it("does not append a route the stop already has", () => {
    const result = applyOverride(ROUTES, { add: ["А03"] });
    expect(result.filter((r) => r.name === "А03")).toHaveLength(1);
  });
});

describe("toggleRoute", () => {
  it("removes an upstream route", () => {
    expect(toggleRoute({}, ROUTES, "А05").remove).toEqual(["А05"]);
  });

  it("puts a removed route back", () => {
    expect(toggleRoute({ remove: ["А05"] }, ROUTES, "А05").remove).toEqual([]);
  });

  it("drops an added route the stop does not serve", () => {
    expect(toggleRoute({ add: ["Т03"] }, ROUTES, "Т03").add).toEqual([]);
  });
});

describe("addRoute", () => {
  it("adds a route the stop does not serve", () => {
    expect(addRoute({}, ROUTES, "Т03").add).toEqual(["Т03"]);
  });

  it("un-removes rather than adds a route the stop already serves", () => {
    const result = addRoute({ remove: ["А05"] }, ROUTES, "А05");
    expect(result).toEqual({ add: [], remove: [] });
  });

  it("ignores a name that is not a route name", () => {
    expect(addRoute({}, ROUTES, "../etc")).toEqual({ add: [], remove: [] });
  });

  it("does not add the same route twice", () => {
    expect(addRoute({ add: ["Т03"] }, ROUTES, "Т03").add).toEqual(["Т03"]);
  });
});

describe("loadOverrides / saveOverrides", () => {
  let originalStorage;

  beforeEach(() => {
    originalStorage = globalThis.localStorage;
    globalThis.localStorage = makeStorage();
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
  });

  it("returns an empty map when nothing is stored", () => {
    expect(loadOverrides()).toEqual({});
  });

  it("round-trips what was saved", () => {
    saveOverrides({ 62: { add: ["Т03"], remove: ["А57"] } });
    expect(loadOverrides()).toEqual({ 62: { add: ["Т03"], remove: ["А57"] } });
  });

  it("stores under the documented key, plain JSON", () => {
    saveOverrides({ 62: { add: ["Т03"], remove: [] } });
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY))).toEqual({
      62: { add: ["Т03"], remove: [] },
    });
  });

  it("falls back to no overrides when the stored value is not JSON", () => {
    globalThis.localStorage.setItem(STORAGE_KEY, "not json");
    expect(loadOverrides()).toEqual({});
  });

  it("falls back to no overrides when storage access throws", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
    };
    expect(loadOverrides()).toEqual({});
  });

  it("reports failure rather than throwing when the write is rejected", () => {
    globalThis.localStorage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(saveOverrides({ 62: { add: ["Т03"], remove: [] } })).toBe(false);
  });

  it("reports success on a normal write", () => {
    expect(saveOverrides({})).toBe(true);
  });
});
