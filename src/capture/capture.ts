import type { MediaPipeFaceTracker } from "../tracking/MediaPipeFaceTracker";
import { fpDistance, Fingerprinter, meanAbsDiff, measure, RunBuilder } from "../analysis/frame";
import { normalise, type Interval } from "../analysis/intervals";
import type { Run } from "../store/types";

export interface Crop { x: number; y: number; w: number; h: number }

export interface CaptureStatus {
  videoT: number;
  uniqueFrames: number;
  duplicates: number;
  faceFrames: number;
  /** Frames per second of new source frames, over the last second. */
  sourceFps: number;
  longGaps: number;
}

/**
 * Analyses a video playing in another window or tab. The player's clock can't be read,
 * so time comes from the start time the reviewer typed plus elapsed wall-clock time
 * between new source frames. Repeated captures of the same source frame are skipped,
 * and any pause longer than MAX_STEP (paused player, buffering) adds at most MAX_STEP,
 * so the estimate does not run ahead while the video is stopped.
 */
const MAX_STEP = 400;
const DUPLICATE_LEVEL = 0.6; // mean grey-level difference at 64×48 below which a frame is a repeat

export class ScreenCapture {
  stream: MediaStream | null = null;
  video: HTMLVideoElement;
  private crop: Crop | null = null;
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private fpr = new Fingerprinter();
  private builder: RunBuilder | null = null;
  private prevMid: Uint8Array | null = null;
  private lastWall = 0;
  private videoT = 0;
  private startT = 0;
  private trackerTs = 0;
  private running = false;
  private recent: number[] = [];
  status: CaptureStatus = { videoT: 0, uniqueFrames: 0, duplicates: 0, faceFrames: 0, sourceFps: 0, longGaps: 0 };
  onStatus?: (s: CaptureStatus) => void;
  onFrame?: (canvas: HTMLCanvasElement) => void;

  constructor(private tracker: MediaPipeFaceTracker) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async choose(): Promise<void> {
    this.stop();
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "never", frameRate: { ideal: 60 } } as MediaTrackConstraints,
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.stream.getVideoTracks()[0].addEventListener("ended", () => this.endedByUser?.());
  }
  endedByUser?: () => void;

  get size() { return { w: this.video.videoWidth, h: this.video.videoHeight }; }
  setCrop(c: Crop | null) { this.crop = c; }

  start(recId: string, startT: number) {
    this.builder = new RunBuilder(recId, { start: startT, end: startT }, true);
    this.startT = startT;
    this.videoT = startT;
    this.lastWall = 0;
    this.prevMid = null;
    this.trackerTs = Math.round(performance.now()) + 1_000_000;
    this.status = { videoT: startT, uniqueFrames: 0, duplicates: 0, faceFrames: 0, sourceFps: 0, longGaps: 0 };
    this.running = true;
    this.loop();
  }

  private loop() {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { this.onCaptured(); this.loop(); });
    else requestAnimationFrame(() => { this.onCaptured(); this.loop(); });
  }

  private onCaptured() {
    if (!this.running || !this.builder || !this.video.videoWidth) return;
    const c = this.crop ?? { x: 0, y: 0, w: this.video.videoWidth, h: this.video.videoHeight };
    const mid = this.fpr.drawMid(this.video, c);
    if (this.prevMid && meanAbsDiff(mid, this.prevMid) < DUPLICATE_LEVEL) { this.status.duplicates++; return; }
    this.prevMid = mid;
    const now = performance.now();
    if (this.lastWall) {
      const step = now - this.lastWall;
      if (step > MAX_STEP) this.status.longGaps++;
      this.videoT += Math.min(step, MAX_STEP);
    }
    this.lastWall = now;
    this.recent.push(now);
    while (this.recent.length && this.recent[0] < now - 1000) this.recent.shift();

    if (this.canvas.width !== c.w || this.canvas.height !== c.h) { this.canvas.width = c.w; this.canvas.height = c.h; }
    this.ctx.drawImage(this.video, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    let values = null;
    try {
      this.trackerTs = Math.max(this.trackerTs + 1, Math.round(now) + 1_000_000);
      values = measure(this.tracker.detect(this.canvas, this.trackerTs).raw);
    } catch (e) { console.warn("capture tracking", e); }
    this.builder.push(this.videoT, values, this.fpr.fingerprint());
    this.status.uniqueFrames++;
    if (values) this.status.faceFrames++;
    this.status.videoT = this.videoT;
    this.status.sourceFps = this.recent.length;
    this.onFrame?.(this.canvas);
    this.onStatus?.(this.status);
  }

  /** Stops analysing and returns what was captured (times still estimated). */
  finish(frameIntervalMs: number): Run | null {
    this.running = false;
    if (!this.builder || !this.builder.count) return null;
    const run = this.builder.finish();
    run.start = this.startT;
    run.end = run.t[run.t.length - 1] + frameIntervalMs;
    this.builder = null;
    return run;
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

export interface Alignment {
  /** Correction to add to the captured times (ms). */
  shiftMs: number;
  confirmed: boolean;
  /** Mean fingerprint distance at the best shift, and the median over all shifts tried. */
  best: number;
  typical: number;
  overlapFrames: number;
}

/**
 * Slides the captured frames against already-stored frames (±searchMs) and picks the
 * shift whose thumbnails match best. Confirmed only if the match is clearly better than
 * typical and close in absolute terms.
 */
export function alignCapture(run: Run, stored: Run[], frameIntervalMs: number, searchMs = 8000): Alignment {
  const refs = stored.filter((r) => r.t.length);
  const cover: Interval[] = normalise(refs.map((r) => ({ start: r.start - searchMs, end: r.end + searchMs })));
  const sample: number[] = [];
  for (let i = 0; i < run.t.length && sample.length < 300; i++) {
    if (cover.some((c) => run.t[i] >= c.start && run.t[i] < c.end)) sample.push(i);
  }
  if (sample.length < 30) return { shiftMs: 0, confirmed: false, best: NaN, typical: NaN, overlapFrames: sample.length };

  const nearest = (x: number): { run: Run; i: number } | null => {
    for (const r of refs) {
      if (x < r.t[0] - frameIntervalMs || x > r.t[r.t.length - 1] + frameIntervalMs) continue;
      let lo = 0, hi = r.t.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.t[m] <= x) lo = m; else hi = m; }
      const i = Math.abs(r.t[lo] - x) <= Math.abs(r.t[hi] - x) ? lo : hi;
      if (Math.abs(r.t[i] - x) <= frameIntervalMs) return { run: r, i };
    }
    return null;
  };

  const step = Math.max(8, frameIntervalMs / 2);
  const scores: { shift: number; d: number; n: number }[] = [];
  for (let shift = -searchMs; shift <= searchMs; shift += step) {
    let s = 0, n = 0;
    for (const i of sample) {
      const m = nearest(run.t[i] + shift);
      if (!m) continue;
      s += fpDistance(run.fp, i, m.run.fp, m.i); n++;
    }
    if (n >= 20) scores.push({ shift, d: s / n, n });
  }
  if (!scores.length) return { shiftMs: 0, confirmed: false, best: NaN, typical: NaN, overlapFrames: 0 };
  const best = scores.reduce((a, b) => (b.d < a.d ? b : a));
  const sorted = scores.map((x) => x.d).sort((a, b) => a - b);
  const typical = sorted[sorted.length >> 1];
  return {
    shiftMs: best.shift,
    confirmed: best.d < 0.6 * typical && best.d < 25,
    best: best.d, typical, overlapFrames: best.n,
  };
}
