import { extractFeatures, segmentCoords, type RawFace } from "../tracking/FeatureExtractor";
import { LM } from "../tracking/landmarks";
import { FIELDS, FP_H, FP_SIZE, FP_W, newId, type Field, type Run } from "../store/types";
import type { Interval } from "./intervals";

export type FrameValues = Record<Field, number>;

/** Codes stored in the "why" column. */
export const WHY = { ok: 0, noFace: 1, eyesOut: 2 } as const;

/**
 * Only the eyes need to be inside the frame. (UC_TFR also requires the forehead, chin and
 * face edges, which rejects every frame where a low laptop camera cuts off the chin.)
 */
const EYE_POINTS = [LM.rEyeOuter, LM.rEyeInner, LM.lEyeInner, LM.lEyeOuter, LM.rIrisCentre, LM.lIrisCentre];

/** Length of the head-pose translation (face to camera). Its scale doesn't matter: only ratios are used. */
export function faceDistance(m: number[] | undefined): number {
  if (!m || m.length !== 16) return NaN;
  const d = Math.hypot(m[12], m[13], m[14]); // column-major: translation is the 4th column
  return d > 0 ? d : NaN;
}

export function whyInvalid(raw: RawFace | undefined): number {
  return raw ? WHY.eyesOut : WHY.noFace;
}

/** Turns one tracker result into the stored measurements, or null if no usable face. */
export function measure(raw: RawFace | undefined, gain = 1): FrameValues | null {
  if (!raw) return null;
  const s = extractFeatures(raw, 0, 0, EYE_POINTS);
  if (!s.valid) return null;
  const f = s.features;
  const n = raw.landmarks;
  const W = raw.imageWidth || 1, H = raw.imageHeight || 1;
  const d = (a: number, b: number) => Math.hypot((n[a].x - n[b].x) * W, (n[a].y - n[b].y) * H);
  const open = (o: number, i: number, u: number, l: number) => { const w = d(o, i); return w > 0 ? d(u, l) / w : NaN; };
  const v = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? NaN : x);
  // Eye values are stored whether or not the eye looks closed (UC_TFR's feature extraction drops
  // them when the blink score is above 0.5 or the lids nearly shut). Looking down lowers the lids,
  // and the face model often scores that as a blink, so the cut-off is applied later, from the
  // stored blink scores and lid openings, with thresholds the reviewer can change.
  const P = (i: number) => ({ x: n[i].x * W, y: n[i].y * H });
  const iris = (a: number, b: number, c: number) => (n.length > c ? segmentCoords(P(c), P(a), P(b)) : null);
  const ri = iris(LM.rEyeOuter, LM.rEyeInner, LM.rIrisCentre), li = iris(LM.lEyeInner, LM.lEyeOuter, LM.lIrisCentre);
  const bs = raw.blendshapes;
  const b = (k: string) => (bs ? (bs[k] ?? 0) : NaN);
  return {
    headH: v(s.gaze?.headOffH), headV: v(s.gaze?.headOffV),
    noseX: v(f.noseX), noseY: v(f.noseY),
    bHL: v(b("eyeLookInLeft") - b("eyeLookOutLeft")), bHR: v(b("eyeLookOutRight") - b("eyeLookInRight")),
    bVL: v(b("eyeLookUpLeft") - b("eyeLookDownLeft")), bVR: v(b("eyeLookUpRight") - b("eyeLookDownRight")),
    iHL: v(li?.along), iHR: v(ri?.along), iVL: v(li?.across), iVR: v(ri?.across),
    blinkL: v(raw.blendshapes?.eyeBlinkLeft), blinkR: v(raw.blendshapes?.eyeBlinkRight),
    openL: open(LM.lEyeOuter, LM.lEyeInner, LM.lEyeUpper, LM.lEyeLower),
    openR: open(LM.rEyeOuter, LM.rEyeInner, LM.rEyeUpper, LM.rEyeLower),
    jaw: v(raw.blendshapes?.jawOpen),
    why: WHY.ok,
    gain,
    dist: faceDistance(raw.transform),
  };
}

/** Collects frames for one continuous analysed interval. */
export class RunBuilder {
  private t: number[] = [];
  private valid: number[] = [];
  private cols: Record<Field, number[]> = Object.fromEntries(FIELDS.map((k) => [k, []])) as unknown as Record<Field, number[]>;
  private fps: Uint8Array[] = [];
  constructor(private recId: string, private interval: Interval, private approx = false) {}
  get count() { return this.t.length; }
  /** why: reason code when values is null (see WHY). */
  push(t: number, values: FrameValues | null, fp: Uint8Array, why: number = WHY.noFace, gain = 1) {
    this.t.push(t);
    this.valid.push(values ? 1 : 0);
    for (const k of FIELDS) this.cols[k].push(values ? values[k] : k === "why" ? why : k === "gain" ? gain : NaN);
    this.fps.push(fp);
  }
  /** end: where this run's coverage stops, if not the end of the interval it was started with. */
  finish(end?: number): Run {
    if (end !== undefined) this.interval = { start: this.interval.start, end };
    const n = this.t.length;
    const fp = new Uint8Array(n * FP_SIZE);
    this.fps.forEach((f, i) => fp.set(f, i * FP_SIZE));
    return {
      id: newId("run"),
      recId: this.recId,
      start: this.interval.start,
      end: this.interval.end,
      approx: this.approx,
      t: Float64Array.from(this.t),
      valid: Uint8Array.from(this.valid),
      cols: Object.fromEntries(FIELDS.map((k) => [k, Float32Array.from(this.cols[k])])) as Record<Field, Float32Array>,
      fp,
      createdAt: Date.now(),
    };
  }
}

/** Keeps only frames inside the given pieces; one run per piece. */
export function splitRun(run: Run, pieces: Interval[]): Run[] {
  const out: Run[] = [];
  for (const p of pieces) {
    const idx: number[] = [];
    for (let i = 0; i < run.t.length; i++) if (run.t[i] >= p.start && run.t[i] < p.end) idx.push(i);
    if (!idx.length) continue;
    const fp = new Uint8Array(idx.length * FP_SIZE);
    idx.forEach((i, j) => fp.set(run.fp.subarray(i * FP_SIZE, (i + 1) * FP_SIZE), j * FP_SIZE));
    out.push({
      ...run,
      id: newId("run"),
      start: p.start,
      end: p.end,
      t: Float64Array.from(idx, (i) => run.t[i]),
      valid: Uint8Array.from(idx, (i) => run.valid[i]),
      cols: Object.fromEntries(FIELDS.map((k) => [k, Float32Array.from(idx, (i) => run.cols[k][i])])) as Record<Field, Float32Array>,
      fp,
    });
  }
  return out;
}

export function shiftRun(run: Run, deltaMs: number): Run {
  return { ...run, start: run.start + deltaMs, end: run.end + deltaMs, t: run.t.map((x) => x + deltaMs) };
}

/**
 * Small greyscale fingerprint of a frame, normalised for brightness and contrast so a
 * screen capture of the player matches the original file's frame.
 */
export class Fingerprinter {
  private mid: HTMLCanvasElement;
  private small: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private sctx: CanvasRenderingContext2D;
  constructor() {
    this.mid = document.createElement("canvas");
    this.mid.width = 64; this.mid.height = 48;
    this.small = document.createElement("canvas");
    this.small.width = FP_W; this.small.height = FP_H;
    this.mctx = this.mid.getContext("2d", { willReadFrequently: true })!;
    this.sctx = this.small.getContext("2d", { willReadFrequently: true })!;
    this.mctx.imageSmoothingQuality = "high";
    this.sctx.imageSmoothingQuality = "high";
  }
  /** Draws the source (or a crop of it) at 64×48 and returns that greyscale image, for duplicate-frame checks. */
  drawMid(src: CanvasImageSource, crop?: { x: number; y: number; w: number; h: number }): Uint8Array {
    if (crop) this.mctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, 64, 48);
    else this.mctx.drawImage(src, 0, 0, 64, 48);
    this.lastMid = grey(this.mctx.getImageData(0, 0, 64, 48).data);
    return this.lastMid;
  }
  /** The last 64×48 greyscale image from drawMid. */
  lastMid: Uint8Array = new Uint8Array(0);
  /** Call after drawMid. */
  fingerprint(): Uint8Array {
    this.sctx.drawImage(this.mid, 0, 0, FP_W, FP_H);
    return normaliseFp(grey(this.sctx.getImageData(0, 0, FP_W, FP_H).data));
  }
}

function grey(rgba: Uint8ClampedArray): Uint8Array {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return g;
}

export function normaliseFp(g: Uint8Array): Uint8Array {
  let m = 0; for (const x of g) m += x; m /= g.length;
  let v = 0; for (const x of g) v += (x - m) ** 2; const sd = Math.sqrt(v / g.length) || 1;
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(128 + 40 * (g[i] - m) / sd)));
  return out;
}

export function fpDistance(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  let s = 0;
  const ao = ai * FP_SIZE, bo = bi * FP_SIZE;
  for (let k = 0; k < FP_SIZE; k++) s += Math.abs(a[ao + k] - b[bo + k]);
  return s / FP_SIZE;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length;
}
