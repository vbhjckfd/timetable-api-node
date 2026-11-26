import { describe, it, expect } from "vitest";

import { stopCodeFor } from "../../utils/stopCode.js";

const none = () => false;

describe("stopCodeFor", () => {
  it("takes the code printed in the stop name", () => {
    expect(stopCodeFor("Чигиринська (576)", "0576", none)).toBe(576);
  });

  it("returns 0 when the name carries no usable code", () => {
    expect(stopCodeFor("Антонича (354-01)", "0354", none)).toBe(0);
    expect(stopCodeFor("ПЛ. СОБОРНА", "0074-01", none)).toBe(0);
  });

  it("falls back to the feed's own stop_code when the name repeats a taken code", () => {
    // GTFS lists stop_code 127 under the name of its neighbour 125.
    const taken = (c) => c === 125;
    expect(
      stopCodeFor('Лікувально-діагностичний центр "Виговського" (125)', "127", taken),
    ).toBe(127);
  });

  it("keeps the name code when the stop_code is no better", () => {
    const taken = (c) => c === 1212 || c === 753;
    expect(stopCodeFor("Великий Дорошів (1212)", "1212", taken)).toBe(1212);
    expect(stopCodeFor("Сихів (754)", "753", (c) => c === 754 || c === 753)).toBe(754);
    expect(stopCodeFor("Гніздовського (193)", "о (3", (c) => c === 193)).toBe(193);
  });
});
