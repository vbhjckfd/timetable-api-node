// @ts-check
/// <reference lib="dom" />

/**
 * Per-stop route overrides for the /stops listing.
 *
 * Stored in the browser's own localStorage, not on a server: no account to
 * edit through, no round trip, no cache to purge. The trade is scope — an
 * edit is visible only in the browser that made it, not to anyone else who
 * opens /stops.
 *
 * The route column is always clickable — there is no separate edit mode. A
 * click only writes to this browser's own storage, so there is nothing for a
 * stray click to damage beyond it.
 *
 * This file is served to the browser as an ES module and imported directly by
 * the test suite, so the DOM half only runs when init() is called.
 */

/**
 * @typedef {{ add: string[], remove: string[] }} Override
 * @typedef {{ add?: unknown, remove?: unknown } | null | undefined} OverrideInput
 *   What storage or a caller hands in: possibly partial, possibly garbage.
 * @typedef {Record<string, OverrideInput>} Overrides Keyed by stop code.
 * @typedef {{ name: string, state: "kept" | "removed" | "added" }} RouteChip
 */

export const STORAGE_KEY = "lad-route-overrides";

export const MAX_ROUTES_PER_LIST = 40;

// Route names are alphanumeric in both alphabets: А03, Т25, 32A, Аеропорт.
const ROUTE_NAME = /^[\p{L}\p{N}]{1,16}$/u;

/**
 * @param {unknown} name
 * @returns {name is string}
 */
export function isValidRouteName(name) {
  return typeof name === "string" && ROUTE_NAME.test(name);
}

/**
 * Trims anything that is not a usable route name, drops duplicates, and caps
 * the length. A name in both lists means remove, since that is the safer read.
 *
 * @param {OverrideInput} entry
 * @returns {Override}
 */
export function normalizeOverride(entry) {
  /** @param {unknown} list */
  const clean = (list) =>
    Array.from(new Set(Array.isArray(list) ? list : []))
      .filter(isValidRouteName)
      .slice(0, MAX_ROUTES_PER_LIST);

  const remove = clean(entry?.remove);
  const add = clean(entry?.add).filter((name) => !remove.includes(name));

  return { add, remove };
}

/** @param {OverrideInput} entry */
export function isEmptyOverride(entry) {
  const { add, remove } = normalizeOverride(entry);
  return add.length === 0 && remove.length === 0;
}

/**
 * The query string timetable-offline and timetable-pdf both understand.
 * Comma-separated, each name percent-encoded: the services split on the comma
 * after decoding, and route names are Cyrillic.
 *
 * @param {OverrideInput} entry
 */
export function overrideQuery(entry) {
  const { add, remove } = normalizeOverride(entry);
  const parts = [];

  if (add.length) parts.push(`add=${add.map(encodeURIComponent).join(",")}`);
  if (remove.length)
    parts.push(`remove=${remove.map(encodeURIComponent).join(",")}`);

  return parts.join("&");
}

/**
 * @param {string | number} code
 * @param {OverrideInput} entry
 * @returns {{ svg: string, pdf: string, schemaSvg: string, schemaPdf: string }}
 */
export function signLinks(code, entry) {
  const query = overrideQuery(entry);
  const suffix = query ? `?${query}` : "";

  return {
    svg: `https://offline.lad.lviv.ua/${code}${suffix}`,
    pdf: `https://pdf.lad.lviv.ua/${code}.pdf${suffix}`,
    schemaSvg: `https://offline.lad.lviv.ua/${code}/schema${suffix}`,
    schemaPdf: `https://pdf.lad.lviv.ua/${code}/schema.pdf${suffix}`,
  };
}

/**
 * The route column as it should read: upstream routes in their own order, the
 * removed ones still shown but struck through, the added ones after them.
 *
 * @param {unknown} routes
 * @param {OverrideInput} entry
 * @returns {RouteChip[]}
 */
export function applyOverride(routes, entry) {
  const { add, remove } = normalizeOverride(entry);
  const upstream = Array.isArray(routes) ? routes : [];

  const kept = upstream.map((/** @type {string} */ name) => ({
    name,
    state: /** @type {RouteChip["state"]} */ (remove.includes(name) ? "removed" : "kept"),
  }));

  const added = add
    .filter((name) => !upstream.includes(name))
    .map((name) => ({ name, state: /** @type {const} */ ("added") }));

  return [...kept, ...added];
}

/**
 * Toggles a name that the API does list for the stop: kept becomes removed and
 * back. Toggling one the API does not list drops it from the add list instead,
 * so a chip added by mistake can be clicked away.
 *
 * @param {OverrideInput} entry
 * @param {unknown} routes
 * @param {string} name
 * @returns {Override}
 */
export function toggleRoute(entry, routes, name) {
  const { add, remove } = normalizeOverride(entry);
  const upstream = Array.isArray(routes) ? routes : [];

  if (!upstream.includes(name)) {
    return normalizeOverride({ add: add.filter((r) => r !== name), remove });
  }

  return normalizeOverride(
    remove.includes(name)
      ? { add, remove: remove.filter((r) => r !== name) }
      : { add, remove: [...remove, name] },
  );
}

/**
 * A name the API already lists for the stop is not added — it is un-removed,
 * which is what asking for it back means.
 *
 * @param {OverrideInput} entry
 * @param {unknown} routes
 * @param {unknown} name
 * @returns {Override}
 */
export function addRoute(entry, routes, name) {
  if (!isValidRouteName(name)) return normalizeOverride(entry);

  const { add, remove } = normalizeOverride(entry);
  const upstream = Array.isArray(routes) ? routes : [];

  if (upstream.includes(name)) {
    return normalizeOverride({ add, remove: remove.filter((r) => r !== name) });
  }

  return normalizeOverride({ add: [...add, name], remove });
}

/**
 * One line of the plain-text summary an editor pastes to whoever maintains
 * the upstream database. "Додати"/"Видалити" only appear when that list is
 * non-empty, so a stop with just one side reads as one clause.
 *
 * @param {string | number} code
 * @param {OverrideInput} entry
 */
export function formatOverrideLine(code, entry) {
  const { add, remove } = normalizeOverride(entry);
  const parts = [`Зупинка №${code}.`];

  if (add.length) parts.push(`Додати ${add.join(", ")}.`);
  if (remove.length) parts.push(`Видалити: ${remove.join(", ")}`);

  return parts.join(" ");
}

/**
 * All overridden stops, one line each, lowest code first. Empty when nothing
 * has been changed, so the caller can hide the box entirely.
 *
 * @param {Overrides | null | undefined} overrides
 */
export function formatSummary(overrides) {
  return Object.keys(overrides ?? {})
    .filter((code) => !isEmptyOverride(/** @type {Overrides} */ (overrides)[code]))
    .sort((a, b) => Number(a) - Number(b))
    .map((code) => formatOverrideLine(code, /** @type {Overrides} */ (overrides)[code]))
    .join("\n");
}

// ── DOM ─────────────────────────────────────────────────────────────────────

/**
 * @param {HTMLTableRowElement} row
 * @param {Overrides} overrides
 */
function renderRow(row, overrides) {
  const code = /** @type {string} */ (row.dataset.code);
  const cell = /** @type {HTMLElement} */ (row.querySelector("[data-routes]"));
  const routes = cell.dataset.routes ? cell.dataset.routes.split(" ") : [];
  const entry = normalizeOverride(overrides[code]);

  cell.textContent = "";
  for (const { name, state } of applyOverride(routes, entry)) {
    const chip = document.createElement("span");
    chip.className = `route ${state}`;
    chip.dataset.route = name;
    chip.textContent = name;
    chip.title = "Клацніть, щоб прибрати або повернути";
    cell.append(chip, document.createTextNode(" "));
  }

  const input = document.createElement("input");
  input.className = "route-add";
  input.size = 6;
  input.placeholder = "+";
  cell.append(input);

  const links = signLinks(code, entry);
  for (const link of /** @type {NodeListOf<HTMLAnchorElement>} */ (row.querySelectorAll("[data-kind]"))) {
    link.href = links[/** @type {keyof typeof links} */ (link.dataset.kind)];
  }
}

/**
 * Reads the stored map. Private browsing / storage-disabled throws on access
 * in some browsers rather than just returning null, and a hand-edited or
 * previous-format value in there is not JSON worth trusting either — either
 * way this falls back to no overrides rather than breaking the listing.
 *
 * @returns {Overrides}
 */
export function loadOverrides() {
  try {
    return JSON.parse(/** @type {string} */ (localStorage.getItem(STORAGE_KEY))) ?? {};
  } catch {
    return {};
  }
}

/** @param {Overrides} overrides */
export function saveOverrides(overrides) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    return true;
  } catch {
    // Storage disabled, full, or the quota was hit — the in-page state still
    // reflects the edit, it just will not survive a reload.
    return false;
  }
}

/** @param {Overrides} overrides */
function renderSummary(overrides) {
  const box = document.getElementById("overrides-summary");
  const textarea = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById("overrides-summary-text")
  );
  if (!box || !textarea) return;

  const text = formatSummary(overrides);
  textarea.value = text;
  box.style.display = text ? "" : "none";
}

export function init() {
  const rows = /** @type {HTMLTableRowElement[]} */ (Array.from(document.querySelectorAll("tr[data-code]")));
  if (!rows.length) return;

  const overrides = loadOverrides();
  for (const row of rows) renderRow(row, overrides);
  renderSummary(overrides);

  const copyButton = document.getElementById("overrides-summary-copy");
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      const textarea = /** @type {HTMLTextAreaElement} */ (
        document.getElementById("overrides-summary-text")
      );
      try {
        await navigator.clipboard.writeText(textarea.value);
      } catch {
        // Clipboard permission denied or unavailable — select it instead so
        // the user can still copy by hand.
        textarea.select();
      }
    });
  }

  /** @param {HTMLTableRowElement} row */
  const routesOf = (row) => {
    const cell = /** @type {HTMLElement} */ (row.querySelector("[data-routes]"));
    return cell.dataset.routes ? cell.dataset.routes.split(" ") : [];
  };

  /**
   * @param {HTMLTableRowElement} row
   * @param {string} code
   */
  const persist = (row, code) => {
    renderRow(row, overrides);
    renderSummary(overrides);
    if (!saveOverrides(overrides)) {
      /** @type {HTMLElement} */ (row.querySelector("[data-routes]")).append(" ⚠️");
    }
  };

  document.addEventListener("click", (event) => {
    const chip = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".route"));
    if (!chip) return;

    const row = /** @type {HTMLTableRowElement} */ (chip.closest("tr[data-code]"));
    const code = /** @type {string} */ (row.dataset.code);
    overrides[code] = toggleRoute(overrides[code], routesOf(row), /** @type {string} */ (chip.dataset.route));
    if (isEmptyOverride(overrides[code])) delete overrides[code];
    persist(row, code);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = /** @type {HTMLInputElement | null} */ (/** @type {Element} */ (event.target).closest(".route-add"));
    if (!input) return;

    const row = /** @type {HTMLTableRowElement} */ (input.closest("tr[data-code]"));
    const code = /** @type {string} */ (row.dataset.code);
    const name = input.value.trim();
    if (!isValidRouteName(name)) return;

    overrides[code] = addRoute(overrides[code], routesOf(row), name);
    if (isEmptyOverride(overrides[code])) delete overrides[code];
    input.value = "";
    persist(row, code);
  });
}

if (typeof document !== "undefined") {
  init();
}
