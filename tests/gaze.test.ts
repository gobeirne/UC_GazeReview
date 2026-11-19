import { describe, expect, test } from "vitest";
import { buildGaze } from "../src/analysis/gazeModel";
import { classify, findEvents, SCREEN } from "../src/analysis/events";
import { DEFAULT_SETTINGS, FIELDS, FP_SIZE, type Field, type Recording, type Run } from "../src/store/types";

/** Deterministic pseudo-random numbers. */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

const rec: Recording = {
  id: "r", name: "t", kind: "file", durationMs: 600_000, width: 640, height: 480, frameIntervalMs: 1000 / 30,
  segments: [], regions: [], settings: { ...DEFAULT_SETTINGS }, createdAt: 0, updatedAt: 0,
};

/**
 * Simulated student: head wanders slowly; while reading the screen (centre 0°, −15°) the eyes
 * offset the head (true eye scale −40°/unit, blendshape convention). Phone glances go to
 * (−40°, −5°) — the student's right — for `glanceFrames` frames.
 */
function simulate(opts: { glances: number[]; glanceFrames: number; headSignFlip?: boolean }) {
  const r = rng(7);
  const dt = 1000 / 30, n = 30 * 300; // 5 minutes
  const cols = Object.fromEntries(FIELDS.map((k) => [k, new Float32Array(n).fill(NaN)])) as Record<Field, Float32Array>;
  const t = new Float64Array(n), valid = new Uint8Array(n).fill(1);
  let hh = 0, hv = -8;
  const kTrue = -40, kTrueV = 40;
  let g = 0;
  for (let i = 0; i < n; i++) {
    t[i] = i * dt;
    hh += 0.08 * gauss(r) - 0.002 * hh; hv += 0.06 * gauss(r) - 0.002 * (hv + 8);
    let target = { h: 0 + 1.5 * gauss(r), v: -15 + 1.5 * gauss(r) };
    if (opts.glances.some((s) => i >= s && i < s + opts.glanceFrames)) target = { h: -40, v: -5 };
    if (g < opts.glances.length && i === opts.glances[g] + opts.glanceFrames) g++;
    const headH = hh + (target.h < -20 ? -8 : 0); // a little head movement with the glance
    const eH = (target.h - headH) / kTrue + 0.01 * gauss(r);
    const eV = (target.v - hv) / kTrueV + 0.01 * gauss(r);
    const s = opts.headSignFlip ? -1 : 1;
    cols.headH[i] = s * headH; cols.headV[i] = s * hv;
    cols.noseX[i] = 0.5 + headH / 100; cols.noseY[i] = 0.5 - hv / 100;
    cols.bHL[i] = eH; cols.bHR[i] = eH; cols.bVL[i] = eV; cols.bVR[i] = eV;
  }
  const run: Run = { id: "a", recId: "r", start: 0, end: n * dt, approx: false, t, valid, cols, fp: new Uint8Array(n * FP_SIZE), createdAt: 0 };
  return run;
}

describe("gaze model", () => {
  const glances = Array.from({ length: 12 }, (_, k) => 600 + k * 650);
  test("fits the eye scale from screen fixations and finds the screen", () => {
    const g = buildGaze([simulate({ glances, glanceFrames: 6 })], rec);
    expect(g.model.kHSource).toMatch(/fitted/);
    expect(g.model.kH).toBeGreaterThan(-46);
    expect(g.model.kH).toBeLessThan(-34);
    expect(Math.abs(g.model.screenH)).toBeLessThanOrEqual(2);
    expect(Math.abs(g.model.screenV + 15)).toBeLessThanOrEqual(2);
  });
  test("recovers flipped head-angle conventions from the nose position", () => {
    const g = buildGaze([simulate({ glances, glanceFrames: 6, headSignFlip: true })], rec);
    expect(g.model.headSignH).toBe(-1);
    expect(g.model.headSignV).toBe(-1);
    expect(g.model.kHSource).toMatch(/fitted/);
  });
  test("lists brief glances as events, and they land on the student's right", () => {
    const g = buildGaze([simulate({ glances, glanceFrames: 4 })], rec);
    const lab = classify(g, []);
    const ev = findEvents(g, lab, 2);
    expect(ev.length).toBe(12);
    for (const e of ev) {
      expect(e.frames).toBeGreaterThanOrEqual(3);
      expect(e.frames).toBeLessThanOrEqual(5);
      expect(e.peakH).toBeLessThan(-30);
    }
    expect(lab.filter((l) => l === SCREEN).length / g.n).toBeGreaterThan(0.95);
  });
  test("labelled regions are reported", () => {
    const g = buildGaze([simulate({ glances, glanceFrames: 6 })], rec);
    const regions = [
      { id: "s", name: "Screen", colour: "#000", isScreen: true, h0: -14, h1: 14, v0: -27, v1: -3 },
      { id: "p", name: "Phone", colour: "#f00", isScreen: false, h0: -50, h1: -30, v0: -15, v1: 5 },
    ];
    const ev = findEvents(g, classify(g, regions), 2);
    expect(ev.length).toBe(12);
    expect(ev.every((e) => e.region === 1)).toBe(true);
  });
});
