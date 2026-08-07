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

export const STORAGE_KEY = "lad-route-overrides";

export const MAX_ROUTES_PER_LIST = 40;

// Route names are alphanumeric in both alphabets: А03, Т25, 32A, Аеропорт.
const ROUTE_NAME = /^[\p{L}\p{N}]{1,16}$/u;

export function isValidRouteName(name) {
  return typeof name === "string" && ROUTE_NAME.test(name);
}

/**
 * Trims anything that is not a usable route name, drops duplicates, and caps
 * the length. A name in both lists means remove, since that is the safer read.
 */
export function normalizeOverride(entry) {
  const clean = (list) =>
    Array.from(new Set(Array.isArray(list) ? list : []))
      .filter(isValidRouteName)
      .slice(0, MAX_ROUTES_PER_LIST);

  const remove = clean(entry?.remove);
  const add = clean(entry?.add).filter((name) => !remove.includes(name));

  return { add, remove };
}

export function isEmptyOverride(entry) {
  const { add, remove } = normalizeOverride(entry);
  return add.length === 0 && remove.length === 0;
}

/**
 * The query string timetable-offline and timetable-pdf both understand.
 * Comma-separated, each name percent-encoded: the services split on the comma
 * after decoding, and route names are Cyrillic.
 */
export function overrideQuery(entry) {
  const { add, remove } = normalizeOverride(entry);
  const parts = [];

  if (add.length) parts.push(`add=${add.map(encodeURIComponent).join(",")}`);
  if (remove.length)
    parts.push(`remove=${remove.map(encodeURIComponent).join(",")}`);

  return parts.join("&");
}

export function signLinks(code, entry) {
  const query = overrideQuery(entry);
  const suffix = query ? `?${query}` : "";

  return {
    svg: `https://offline.lad.lviv.ua/${code}${suffix}`,
    pdf: `https://pdf.lad.lviv.ua/${code}.pdf${suffix}`,
  };
}

/**
 * The route column as it should read: upstream routes in their own order, the
 * removed ones still shown but struck through, the added ones after them.
 */
export function applyOverride(routes, entry) {
  const { add, remove } = normalizeOverride(entry);
  const upstream = Array.isArray(routes) ? routes : [];

  const kept = upstream.map((name) => ({
    name,
    state: remove.includes(name) ? "removed" : "kept",
  }));

  const added = add
    .filter((name) => !upstream.includes(name))
    .map((name) => ({ name, state: "added" }));

  return [...kept, ...added];
}

/**
 * Toggles a name that the API does list for the stop: kept becomes removed and
 * back. Toggling one the API does not list drops it from the add list instead,
 * so a chip added by mistake can be clicked away.
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

// ── DOM ─────────────────────────────────────────────────────────────────────

function renderRow(row, overrides) {
  const code = row.dataset.code;
  const cell = row.querySelector("[data-routes]");
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
  for (const link of row.querySelectorAll("[data-kind]")) {
    link.href = links[link.dataset.kind];
  }
}

/**
 * Reads the stored map. Private browsing / storage-disabled throws on access
 * in some browsers rather than just returning null, and a hand-edited or
 * previous-format value in there is not JSON worth trusting either — either
 * way this falls back to no overrides rather than breaking the listing.
 */
export function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

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

export function init() {
  const rows = Array.from(document.querySelectorAll("tr[data-code]"));
  if (!rows.length) return;

  const overrides = loadOverrides();
  for (const row of rows) renderRow(row, overrides);

  const routesOf = (row) => {
    const cell = row.querySelector("[data-routes]");
    return cell.dataset.routes ? cell.dataset.routes.split(" ") : [];
  };

  const persist = (row, code) => {
    renderRow(row, overrides);
    if (!saveOverrides(overrides)) {
      row.querySelector("[data-routes]").append(" ⚠️");
    }
  };

  document.addEventListener("click", (event) => {
    const chip = event.target.closest(".route");
    if (!chip) return;

    const row = chip.closest("tr[data-code]");
    const code = row.dataset.code;
    overrides[code] = toggleRoute(overrides[code], routesOf(row), chip.dataset.route);
    if (isEmptyOverride(overrides[code])) delete overrides[code];
    persist(row, code);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.target.closest(".route-add");
    if (!input) return;

    const row = input.closest("tr[data-code]");
    const code = row.dataset.code;
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
