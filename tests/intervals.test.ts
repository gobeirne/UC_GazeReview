import { describe, expect, test } from "vitest";
import { contains, normalise, subtract, totalLength, union } from "../src/analysis/intervals";

describe("intervals", () => {
  test("normalise merges overlaps and touching intervals", () => {
    expect(normalise([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 10 }]))
      .toEqual([{ start: 0, end: 4 }, { start: 5, end: 10 }]);
  });
  test("subtract leaves only the uncovered parts", () => {
    const have = [{ start: 10, end: 20 }, { start: 30, end: 40 }];
    expect(subtract({ start: 0, end: 50 }, have)).toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 50 }]);
    expect(subtract({ start: 12, end: 18 }, have)).toEqual([]);
    expect(subtract({ start: 15, end: 35 }, have)).toEqual([{ start: 20, end: 30 }]);
  });
  test("subtract drops slivers shorter than the minimum", () => {
    expect(subtract({ start: 0, end: 100 }, [{ start: 0, end: 99 }], 5)).toEqual([]);
  });
  test("overlapping segments cost one pass over their union", () => {
    let cov = union([], [{ start: 300_000, end: 900_000 }]);
    const gaps = subtract({ start: 600_000, end: 1_200_000 }, cov);
    expect(gaps).toEqual([{ start: 900_000, end: 1_200_000 }]);
    cov = union(cov, gaps);
    expect(totalLength(cov)).toBe(900_000);
    expect(contains(cov, 899_999)).toBe(true);
    expect(contains(cov, 1_200_000)).toBe(false);
  });
});
