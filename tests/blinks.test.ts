import { describe, expect, test } from "vitest";
import { removeBlinks } from "../src/analysis/gazeModel";

/** 30 fps; steady eyes with a 5-frame blink (lids dip, eye estimate drops) and a 1 s look down. */
function trace() {
  const n = 120, dt = 1000 / 30;
  const t = Float64Array.from({ length: n }, (_, i) => i * dt);
  const eH = new Float32Array(n).fill(0.1), eV = new Float32Array(n).fill(0);
  const lid = new Float32Array(n).fill(1);
  // Blink: frames 20–24 (lids 0.8 → 0.2 → 0.8); frames 21–23 below 70%.
  [0.85, 0.5, 0.2, 0.45, 0.85].forEach((l, k) => { lid[20 + k] = l; eV[20 + k] = -0.4 * (1 - l); });
  // Look down at the desk: frames 60–89, lids at 55% the whole time, eyes down.
  for (let i = 60; i < 90; i++) { lid[i] = 0.55; eV[i] = -0.5; }
  return { t, eH, eV, lid, brk: new Uint8Array(n).fill(0).map((_, i) => (i === 0 ? 1 : 0)) };
}

describe("blink removal", () => {
  test("flattens a short lid dip and leaves a long look down alone", () => {
    const { t, eH, eV, lid, brk } = trace();
    const out = new Uint8Array(t.length);
    const n = removeBlinks(t, eH, eV, lid, brk, 0.7, 400, out);
    expect(n).toBe(1);
    for (let i = 19; i <= 25; i++) expect(Math.abs(eV[i])).toBeLessThan(0.05);
    for (let i = 60; i < 90; i++) expect(eV[i]).toBe(-0.5);
    expect(out.slice(60, 90).every((x) => x === 0)).toBe(true);
  });
  test("the duration limit decides between blink and look down", () => {
    const { t, eH, eV, lid, brk } = trace();
    const out = new Uint8Array(t.length);
    expect(removeBlinks(t, eH, eV, lid, brk, 0.7, 2000, out)).toBe(2);
  });
});

describe("closed-eye cut-off", () => {
  test("thresholds decide when an eye's values are used", async () => {
    const { eyeOpen } = await import("../src/analysis/gazeModel");
    const def = { eyeBlinkMax: 0.5, eyeOpenMin: 0.12 };
    expect(eyeOpen(0.3, 0.2, def)).toBe(true);
    expect(eyeOpen(0.6, 0.2, def)).toBe(false);   // looking down scored as a blink
    expect(eyeOpen(0.6, 0.2, { eyeBlinkMax: 0.8, eyeOpenMin: 0.12 })).toBe(true);
    expect(eyeOpen(0.3, 0.08, def)).toBe(false);
    expect(eyeOpen(0.3, 0.08, { eyeBlinkMax: 0.5, eyeOpenMin: 0.05 })).toBe(true);
    expect(eyeOpen(NaN, NaN, def)).toBe(true);    // older analyses: no scores stored
  });
});
