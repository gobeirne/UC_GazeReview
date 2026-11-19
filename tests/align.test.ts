import { describe, expect, test } from "vitest";
import { alignCapture } from "../src/capture/capture";
import { normaliseFp } from "../src/analysis/frame";
import { FIELDS, FP_SIZE, type Field, type Run } from "../src/store/types";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

/** A "video" whose thumbnails change smoothly over time, so neighbouring frames differ a little. */
function thumbs(n: number, seed: number) {
  const r = rng(seed);
  const base = Array.from({ length: FP_SIZE }, () => r() * 255);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < FP_SIZE; k++) base[k] = Math.max(0, Math.min(255, base[k] + (r() - 0.5) * 30));
    out.push(normaliseFp(Uint8Array.from(base)));
  }
  return out;
}

function run(t: number[], fps: Uint8Array[], start: number, end: number): Run {
  const fp = new Uint8Array(t.length * FP_SIZE);
  fps.forEach((f, i) => fp.set(f, i * FP_SIZE));
  return {
    id: "x" + start, recId: "r", start, end, approx: true, t: Float64Array.from(t), valid: new Uint8Array(t.length),
    cols: Object.fromEntries(FIELDS.map((k) => [k, new Float32Array(t.length)])) as Record<Field, Float32Array>, fp, createdAt: 0,
  };
}

describe("capture alignment", () => {
  const dt = 1000 / 30;
  const n = 30 * 60;
  const frames = thumbs(n, 3);
  const times = frames.map((_, i) => i * dt);
  const stored = run(times.slice(0, 900), frames.slice(0, 900), 0, 900 * dt);

  test("finds the offset of a capture that overlaps earlier frames", () => {
    // Capture of frames 600–1500, typed start 1.5 s late, with slight capture noise.
    const r = rng(11);
    const capFp = frames.slice(600, 1500).map((f) => normaliseFp(f.map((x) => Math.max(0, Math.min(255, x + (r() - 0.5) * 16)))));
    const capT = times.slice(600, 1500).map((x) => x + 1500);
    const a = alignCapture(run(capT, capFp, capT[0], capT[capT.length - 1] + dt), [stored], dt);
    expect(a.confirmed).toBe(true);
    expect(Math.abs(a.shiftMs + 1500)).toBeLessThanOrEqual(dt);
  });

  test("does not confirm a capture of different video", () => {
    const other = thumbs(900, 99);
    const capT = times.slice(600, 1500);
    const a = alignCapture(run(capT, other, capT[0], capT[capT.length - 1] + dt), [stored], dt);
    expect(a.confirmed).toBe(false);
  });
});
