import type { Region } from "../store/types";
import type { GazeSeries } from "./gazeModel";

/** Per-frame label: region index, SCREEN, ELSEWHERE (off-screen, unlabelled) or NONE (no gaze). */
export const NONE = -1, ELSEWHERE = -2, SCREEN = -3;

export interface GazeEvent {
  start: number;
  end: number;
  frames: number;
  /** Region index into the regions array, or ELSEWHERE. */
  region: number;
  peakH: number;
  peakV: number;
  /** Largest angular distance from the screen centre during the event (°). */
  peakDist: number;
  /** Smallest lid opening during the event relative to the student's median (1 = typical). Low values suggest a blink or a look down rather than a look across. */
  lidMin: number;
}

/**
 * Labels every frame. Non-screen regions take priority over screen regions where they
 * overlap. With no screen region defined, the fitted screen cluster stands in for one.
 */
export function classify(g: GazeSeries, regions: Region[]): Int16Array {
  const lab = new Int16Array(g.n);
  const order = regions.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r.isScreen) - Number(b.r.isScreen));
  const hasScreen = regions.some((r) => r.isScreen);
  for (let k = 0; k < g.n; k++) {
    if (!g.ok[k]) { lab[k] = NONE; continue; }
    const h = g.h[k], v = g.v[k];
    let l = hasScreen ? ELSEWHERE : (g.onScreen[k] ? SCREEN : ELSEWHERE);
    for (const { r, i } of order) {
      if (h >= Math.min(r.h0, r.h1) && h <= Math.max(r.h0, r.h1) && v >= Math.min(r.v0, r.v1) && v <= Math.max(r.v0, r.v1)) {
        l = r.isScreen ? SCREEN : i;
        break;
      }
    }
    lab[k] = l;
  }
  return lab;
}

/**
 * Off-screen excursions: consecutive frames labelled anything but SCREEN. Frames without
 * gaze (NONE) inside an excursion are bridged for up to `bridgeFrames`; longer gaps end it.
 * A time gap in the data (break) always ends it.
 */
export function findEvents(g: GazeSeries, lab: Int16Array, minFrames: number, bridgeFrames = 2): GazeEvent[] {
  const events: GazeEvent[] = [];
  const dt = g.model.frameIntervalMs;
  let cur: { s: number; e: number; counts: Map<number, number>; n: number; pk: number; pd: number; lid: number } | null = null;
  let noneRun = 0;
  const close = () => {
    if (cur && cur.n >= minFrames) {
      let region = ELSEWHERE, best = 0;
      for (const [r, c] of cur.counts) if (r >= 0 && c > best) { best = c; region = r; }
      events.push({ start: g.t[cur.s], end: g.t[cur.e] + dt, frames: cur.n, region, peakH: g.h[cur.pk], peakV: g.v[cur.pk], peakDist: cur.pd, lidMin: cur.lid });
    }
    cur = null; noneRun = 0;
  };
  for (let k = 0; k < g.n; k++) {
    if (g.breakBefore[k]) close();
    const l = lab[k];
    if (l === NONE) {
      if (cur && ++noneRun > bridgeFrames) close();
      continue;
    }
    if (l === SCREEN) { close(); continue; }
    noneRun = 0;
    const d = Math.hypot(g.h[k] - g.model.screenH, g.v[k] - g.model.screenV);
    if (!cur) cur = { s: k, e: k, counts: new Map(), n: 0, pk: k, pd: d, lid: Infinity };
    if (Number.isFinite(g.lid[k])) cur.lid = Math.min(cur.lid, g.lid[k]);
    cur.e = k; cur.n++;
    cur.counts.set(l, (cur.counts.get(l) ?? 0) + 1);
    if (d > cur.pd) { cur.pd = d; cur.pk = k; }
  }
  close();
  return events;
}

/** Total time per label within [t0, t1). */
export function dwell(g: GazeSeries, lab: Int16Array, t0: number, t1: number): Map<number, number> {
  const m = new Map<number, number>();
  const dt = g.model.frameIntervalMs;
  for (let k = 0; k < g.n; k++) if (g.t[k] >= t0 && g.t[k] < t1) m.set(lab[k], (m.get(lab[k]) ?? 0) + dt);
  return m;
}
