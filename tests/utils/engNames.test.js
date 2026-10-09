import { describe, it, expect } from "vitest";

import {
  buildEngNames,
  engNameFor,
  sameStopName,
  transliterate,
} from "../../utils/engNames.js";

describe("sameStopName", () => {
  it("accepts the same stop spelled differently", () => {
    expect(sameStopName("Площа Соборна", "Соборна")).toBe(true);
    expect(sameStopName("Рудне, Стуса", "Рудно, Стуса")).toBe(true);
  });

  it("rejects another stop", () => {
    expect(sameStopName("Стрийський ринок", "Словацького")).toBe(false);
    expect(sameStopName("Поліклініка № 3", 'Лікувально-діагностичний центр "Левандівка"')).toBe(false);
  });

  it("does not let a shared village name make two stops alike", () => {
    expect(sameStopName("Брюховичі, Івасюка", "Брюховичі, Прилуцька")).toBe(false);
    expect(sameStopName("Великі Грибовичі, Садова", "Великі Грибовичі, Шкільна")).toBe(false);
  });
});

describe("transliterate", () => {
  it("follows the national transliteration", () => {
    expect(transliterate("Словацького")).toBe("Slovatskoho");
    expect(transliterate("Щурата")).toBe("Shchurata");
    expect(transliterate("Лисиничі, Квіткова")).toBe("Lysynychi, Kvitkova");
  });

  it("spells є ї й ю я differently at the start of a word", () => {
    expect(transliterate("Єрошенка")).toBe("Yeroshenka");
    expect(transliterate("Їжакевича")).toBe("Yizhakevycha");
    expect(transliterate("Яворівська")).toBe("Yavorivska");
    expect(transliterate("Надії Мудрої")).toBe("Nadii Mudroi");
  });

  it("drops the apostrophe and writes зг as zgh", () => {
    expect(transliterate("Кам'янка")).toBe("Kamianka");
    expect(transliterate("Згорани")).toBe("Zghorany");
  });
});

describe("engNameFor", () => {
  const names = buildEngNames([
    { code: 74, uk: "Площа Соборна", en: "Soborna square" },
    { code: 8, uk: "Стрийський ринок", en: "Stryiskyi market" },
    { code: 900, uk: "Садова", en: "Sadova" },
    { code: 5, uk: "", en: "Kept" },
  ]);

  it("uses the row of the code when it names the same stop", () => {
    expect(engNameFor(74, "Соборна", names)).toBe("Soborna square");
  });

  it("trusts a row that gives no Ukrainian name", () => {
    expect(engNameFor(5, "Будь-яка", names)).toBe("Kept");
  });

  it("looks the name up when the code's row is another stop's", () => {
    expect(engNameFor(171, "Садова", names)).toBe("Sadova");
  });

  it("transliterates when the sheet has nothing for it", () => {
    expect(engNameFor(8, "Словацького", names)).toBe("Slovatskoho");
  });
});
