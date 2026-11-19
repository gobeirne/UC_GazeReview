import type { FrameValues } from "./frame";
import { avg, indexAt, PRIORS, type GazeSeries } from "./gazeModel";
import type { RecordingSettings } from "../store/types";

export interface LivePoint { t: number; h: number; v: number }

/**
 * Projects frames tracked during playback with the model fitted from the saved analysis
 * (head signs, eye scale, and the drift correction of the nearest analysed frame). With
 * no saved analysis yet, the default eye scale is used and head signs are assumed, so
 * positions are only approximate. Live frames are shown, never saved.
 */
export class LiveGaze {
  private lastEye = { t: -Infinity, h: NaN, v: NaN };
  trail: LivePoint[] = [];
  last: LivePoint | null = null;

  reset() { this.trail = []; this.last = null; this.lastEye = { t: -Infinity, h: NaN, v: NaN }; }

  push(t: number, values: FrameValues | null, g: GazeSeries | null, s: RecordingSettings): LivePoint | null {
    if (this.last && (t < this.last.t || t - this.last.t > 1000)) this.reset();
    if (!values) { this.last = null; return null; }
    let eh: number, ev: number;
    if (s.eyeSource === "blend") { eh = avg(values.bHL, values.bHR); ev = avg(values.bVL, values.bVR); }
    else { eh = avg(values.iHL, values.iHR) - 0.5; ev = avg(values.iVL, values.iVR); }
    // Live can't look ahead, so a blink holds the last eye position instead of interpolating.
    const lidMed = g?.model.lidMedian;
    const lid = avg(values.openL, values.openR);
    const closing = s.blinkFilter && Number.isFinite(lidMed) && Number.isFinite(lid) && lid / lidMed! < s.blinkLidPct / 100;
    if (!closing && Number.isFinite(eh) && Number.isFinite(ev)) this.lastEye = { t, h: eh, v: ev };
    else if (t - this.lastEye.t <= Math.max(s.blinkHoldMs, s.blinkFilter ? s.blinkMaxMs : 0)) { eh = this.lastEye.h; ev = this.lastEye.v; }
    else if (!(Number.isFinite(eh) && Number.isFinite(ev))) { this.last = null; return null; }
    const m = g?.model;
    const prior = PRIORS[s.eyeSource];
    const kH = s.kH ?? m?.kH ?? prior.kH, kV = s.kV ?? m?.kV ?? prior.kV;
    let h = (m?.headSignH ?? 1) * values.headH + kH * eh;
    let v = (m?.headSignV ?? 1) * values.headV + kV * ev;
    if (!Number.isFinite(h) || !Number.isFinite(v)) { this.last = null; return null; }
    if (g && g.n) {
      const i = Math.max(0, indexAt(g.t, t));
      const j = Math.min(g.n - 1, i + 1);
      const k = Math.abs(g.t[j] - t) < Math.abs(g.t[i] - t) ? j : i;
      if (Math.abs(g.t[k] - t) < 30000) { h += g.dH[k]; v += g.dV[k]; }
    }
    const p = { t, h, v };
    this.last = p;
    this.trail.push(p);
    while (this.trail.length && this.trail[0].t < t - 2500) this.trail.shift();
    return p;
  }
}
