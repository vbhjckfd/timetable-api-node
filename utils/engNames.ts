/**
 * English stop names. The spreadsheet of English names is keyed by stop code,
 * but codes there have drifted: some rows name a stop that has since been
 * renamed (Поліклініка № 3 is now ЛДЦ «Левандівка»), others belong to another
 * stop altogether (code 8 is Словацького in GTFS, Стрийський ринок in the
 * sheet). So a row is used only when its Ukrainian name matches the GTFS name;
 * otherwise the sheet is searched by name, and failing that the name is
 * transliterated.
 */

const key = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function similarity(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

/**
 * Same stop, spelled differently: "Соборна" / "Площа Соборна", "Рудно" /
 * "Рудне". A shared "Village, " prefix is set aside first, or every two stops
 * of one village would pass.
 */
export function sameStopName(a: string, b: string): boolean {
  const [pa, ...ra] = a.split(",");
  const [pb, ...rb] = b.split(",");
  if (ra.length && rb.length && key(pa) === key(pb)) {
    [a, b] = [ra.join(","), rb.join(",")];
  }
  const [ka, kb] = [key(a), key(b)];
  if (!ka || !kb) return false;
  return ka.includes(kb) || kb.includes(ka) || similarity(ka, kb) >= 0.7;
}

// Ukrainian national transliteration (Cabinet of Ministers resolution 55, 2010).
const LETTERS: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh",
  з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia",
};
const WORD_START: Record<string, string> = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
const APOSTROPHES = /['’ʼ`]/;

export function transliterate(name: string): string {
  const chars = [...name];
  return chars
    .map((ch, i) => {
      const lower = ch.toLowerCase();
      const prev = (chars[i - 1] ?? "").toLowerCase();
      // an apostrophe inside a word is dropped: Кам'янка -> Kamianka
      if (APOSTROPHES.test(ch) && /\p{L}/u.test(prev)) return "";
      if (!(lower in LETTERS)) return ch;
      const wordStart = !/\p{L}/u.test(prev) && !APOSTROPHES.test(prev);
      let latin =
        lower === "г" && prev === "з" // зг -> zgh, to tell it from ж
          ? "gh"
          : (wordStart && WORD_START[lower]) || LETTERS[lower];
      if (ch !== lower && latin) latin = latin[0].toUpperCase() + latin.slice(1);
      return latin;
    })
    .join("");
}

export interface EngNameRow {
  code: number;
  uk: string;
  en: string;
}

export interface EngNames {
  byCode: Map<number, { uk: string; en: string }>;
  byName: Map<string, string>;
}

/** Sheet rows ({ code, uk, en }) -> lookups by code and by Ukrainian name. */
export function buildEngNames(rows: Iterable<EngNameRow>): EngNames {
  const byCode: EngNames["byCode"] = new Map();
  const byName: EngNames["byName"] = new Map();
  for (const { code, uk, en } of rows) {
    if (!en) continue;
    if (!byCode.has(code)) byCode.set(code, { uk, en });
    if (uk && !byName.has(key(uk))) byName.set(key(uk), en);
  }
  return { byCode, byName };
}

export function engNameFor(code: number, name: string, { byCode, byName }: EngNames): string {
  const row = byCode.get(code);
  if (row && (!row.uk || sameStopName(row.uk, name))) return row.en;
  return byName.get(key(name)) ?? transliterate(name);
}
