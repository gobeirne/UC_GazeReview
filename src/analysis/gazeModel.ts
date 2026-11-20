import type { Recording, Run, RecordingSettings } from "../store/types";

/**
 * Projects every analysed frame onto a camera-centred gaze plane (azimuth, elevation in °):
 *
 *   gazeH = sH·headH + kH·eyeH        gazeV = sV·headV + kV·eyeV
 *
 * Display convention: (0,0) is the camera; h positive is towards the image right (the
 * person's left); v positive is up. sH and sV fix the tracker's head-angle signs from the
 * geometric nose position. k converts the eye measure to degrees. It is fitted from the
 * person's own fixations on the screen, where head movements are offset by opposite eye
 * movements (H + k·E ≈ constant), falling back to a prior. The same idea is used for
 * eye-contact mode in UC_TFR (EyeContactModel.ts, "fitted from postures").
 */

export interface GazeSeries {
  t: Float64Array;
  h: Float32Array;
  v: Float32Array;
  /** 1 = gaze available (face tracked and an eye value within the blink hold). */
  ok: Uint8Array;
  /** 1 = this frame starts a new continuous stretch (run start or time gap). */
  breakBefore: Uint8Array;
  /** 1 = frame classed as on-screen by the cluster model. */
  onScreen: Uint8Array;
  /** Lid opening relative to this person's median (1 = typical; NaN = unknown). */
  lid: Float32Array;
  /** 1 = a blink was removed here (eye movement replaced by interpolation). */
  blink: Uint8Array;
  /** Drift correction applied to each frame (°), so live frames can be corrected the same way. */
  dH: Float32Array;
  dV: Float32Array;
  n: number;
  model: GazeModelInfo;
}

export interface GazeModelInfo {
  kH: number; kV: number;
  kHSource: string; kVSource: string;
  rH: number; rV: number;
  headSignH: number; headSignV: number;
  headSignNote: string;
  screenH: number; screenV: number;
  /** Radius (°) used to decide screen membership when fitting. */
  screenRadius: number;
  screenFraction: number;
  frameIntervalMs: number;
  validFraction: number;
  /** The person's median lid opening (lid gap / eye width), for live blink detection. */
  lidMedian: number;
  blinksRemoved: number;
  /** Why frames have no gaze, as fractions of all analysed frames. */
  missing: { noFace: number; eyesOut: number; eyesClosed: number; olderAnalysis: number };
  /** Fraction of frames brightened before tracking. */
  brightened: number;
  /** Median face-to-camera distance (relative units), and the range of distance ratios seen (5th–95th percentile). */
  distMedian: number;
  distRange: [number, number];
  /** Fraction of frames with gaze but no distance (analysed before distances were recorded). */
  distMissing: number;
  distanceCorrected: boolean;
}

/** Prior degrees per unit of eye measure, with the sign for the display convention. */
export const PRIORS = {
  // Blendshape gaze: positive H = towards the person's right (image left); positive V = up.
  blend: { kH: -40, kV: 40 },
  // Iris: H increases towards image right; V ("across") increases downwards.
  iris: { kH: 140, kV: -140 },
};

const SCREEN_RADIUS = 12;

export function buildGaze(runs: Run[], rec: Recording): GazeSeries {
  const s = rec.settings;
  // Frames from all runs in time order (runs normally don't overlap; unaligned captures may).
  const refs: { r: Run; j: number }[] = [];
  for (const r of runs) for (let j = 0; j < r.t.length; j++) refs.push({ r, j });
  refs.sort((a, b) => a.r.t[a.j] - b.r.t[b.j]);
  const n = refs.length;
  const t = new Float64Array(n), headH = new Float32Array(n), headV = new Float32Array(n);
  const noseX = new Float32Array(n), noseY = new Float32Array(n), eH = new Float32Array(n), eV = new Float32Array(n);
  const valid = new Uint8Array(n), breakBefore = new Uint8Array(n), lid = new Float32Array(n), dist = new Float32Array(n);
  const gapMs = Math.max(150, rec.frameIntervalMs * 4);

  let lastEyeT = -Infinity, lastH = NaN, lastV = NaN;
  let nNoFace = 0, nEyesOut = 0, nOlder = 0, nBright = 0;
  for (let i = 0; i < n; i++) {
    const { r, j } = refs[i];
    const c = r.cols;
    if (!r.valid[j]) {
      const why = c.why[j];
      if (why === 1) nNoFace++; else if (why === 2) nEyesOut++; else nOlder++;
    }
    if (c.gain[j] > 1.05) nBright++;
    t[i] = r.t[j];
    // Runs that follow on from each other (saved in pieces) join up; an unaligned capture never does.
    const otherRun = i > 0 && refs[i - 1].r !== r && (refs[i - 1].r.approx || r.approx);
    breakBefore[i] = i === 0 || otherRun || t[i] - t[i - 1] > gapMs ? 1 : 0;
    if (breakBefore[i]) lastEyeT = -Infinity;
    valid[i] = r.valid[j];
    headH[i] = c.headH[j]; headV[i] = c.headV[j]; noseX[i] = c.noseX[j]; noseY[i] = c.noseY[j];
    lid[i] = valid[i] ? avg(c.openL[j], c.openR[j]) : NaN;
    let h: number, v: number;
    if (s.eyeSource === "blend") { h = avg(c.bHL[j], c.bHR[j]); v = avg(c.bVL[j], c.bVR[j]); }
    else { h = avg(c.iHL[j], c.iHR[j]) - 0.5; v = avg(c.iVL[j], c.iVR[j]); }
    if (Number.isFinite(h) && Number.isFinite(v)) { lastEyeT = t[i]; lastH = h; lastV = v; }
    else if (t[i] - lastEyeT <= s.blinkHoldMs) { h = lastH; v = lastV; }
    eH[i] = h; eV[i] = v;
    dist[i] = valid[i] ? c.dist[j] : NaN;
  }

  const lids: number[] = [];
  for (let k = 0; k < n; k += 3) if (Number.isFinite(lid[k])) lids.push(lid[k]);
  const lidMed = lids.length ? median(lids) : NaN;
  for (let k = 0; k < n; k++) lid[k] = lid[k] / lidMed;

  const blink = new Uint8Array(n);
  const blinksRemoved = s.blinkFilter ? removeBlinks(t, eH, eV, lid, breakBefore, s.blinkLidPct / 100, s.blinkMaxMs, blink) : 0;

  // Head sign conventions from the geometric nose position (image-right / downward movement).
  const rx = corr(headH, noseX, valid), ry = corr(headV, noseY, valid);
  const headSignH = Number.isFinite(rx) && Math.abs(rx) > 0.1 ? Math.sign(rx) : 1;
  const headSignV = Number.isFinite(ry) && Math.abs(ry) > 0.1 ? -Math.sign(ry) : 1;
  const headSignNote = Math.abs(rx) > 0.1 && Math.abs(ry) > 0.1 ? "from nose position" :
    "head moved too little to confirm direction; assumed";
  const H = headH.map((x) => x * headSignH), V = headV.map((x) => x * headSignV);

  const prior = PRIORS[s.eyeSource];
  let kH = s.kH ?? prior.kH, kV = s.kV ?? prior.kV;
  const ok = new Uint8Array(n);
  for (let k = 0; k < n; k++) ok[k] = valid[k] && Number.isFinite(H[k]) && Number.isFinite(V[k]) && Number.isFinite(eH[k]) && Number.isFinite(eV[k]) ? 1 : 0;

  const gh = new Float32Array(n), gv = new Float32Array(n);
  // Distance: angles to things near the camera grow as the person leans in (a phone 20 cm to the side
  // is 18° away at 60 cm but 39° at 25 cm). Rescaling each frame's angles to the person's usual
  // distance keeps those things in the same place on the plane.
  const dists: number[] = [];
  for (let k = 0; k < n; k += 2) if (Number.isFinite(dist[k])) dists.push(dist[k]);
  const distMed = dists.length >= 20 ? median(dists) : NaN;
  const useDist = s.distanceCorrection && Number.isFinite(distMed);
  const ratios = Number.isFinite(distMed) ? dists.map((d) => d / distMed).sort((a, b) => a - b) : [];
  const pq = (p: number) => ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))] : NaN;
  let nNoDist = 0, nGaze = 0;
  for (let k = 0; k < n; k++) if (valid[k]) { nGaze++; if (!Number.isFinite(dist[k])) nNoDist++; }
  const project = () => {
    for (let k = 0; k < n; k++) {
      gh[k] = H[k] + kH * eH[k]; gv[k] = V[k] + kV * eV[k];
      if (useDist && Number.isFinite(dist[k])) {
        const r = dist[k] / distMed;
        gh[k] = rescaleAngle(gh[k], r); gv[k] = rescaleAngle(gv[k], r);
      }
    }
  };
  project();
  let centre = densestPoint(gh, gv, ok);
  let member = membership(gh, gv, ok, centre, SCREEN_RADIUS);

  let kHSource = s.kH !== null ? "set by reviewer" : "prior", kVSource = s.kV !== null ? "set by reviewer" : "prior";
  let rH = NaN, rV = NaN;
  if (s.kH === null || s.kV === null) {
    const fitH = fitK(H, eH, member), fitV = fitK(V, eV, member);
    rH = fitH.r; rV = fitV.r;
    if (s.kH === null) { const why = rejectReason(fitH, prior.kH); if (why) kHSource = `prior (${why})`; else { kH = fitH.k; kHSource = "fitted from screen fixations"; } }
    if (s.kV === null) { const why = rejectReason(fitV, prior.kV); if (why) kVSource = `prior (${why})`; else { kV = fitV.k; kVSource = "fitted from screen fixations"; } }
    project();
    centre = densestPoint(gh, gv, ok);
    member = membership(gh, gv, ok, centre, SCREEN_RADIUS);
  }

  // Follow slow posture drift using on-screen frames only.
  const dH = new Float32Array(n), dV = new Float32Array(n);
  if (s.driftWindowS > 0) {
    for (let pass = 0; pass < 2; pass++) {
      const bh = baseline(t, gh, member, s.driftWindowS * 1000, centre.h);
      const bv = baseline(t, gv, member, s.driftWindowS * 1000, centre.v);
      for (let k = 0; k < n; k++) {
        gh[k] -= bh[k] - centre.h; gv[k] -= bv[k] - centre.v;
        dH[k] -= bh[k] - centre.h; dV[k] -= bv[k] - centre.v;
      }
      member = membership(gh, gv, ok, centre, SCREEN_RADIUS);
    }
  }

  let nOk = 0, nMem = 0;
  for (let k = 0; k < n; k++) { nOk += ok[k]; nMem += member[k]; }
  return {
    t, h: gh, v: gv, ok, breakBefore, onScreen: member, lid, blink, dH, dV, n,
    model: {
      kH, kV, kHSource, kVSource, rH, rV, headSignH, headSignV, headSignNote,
      screenH: centre.h, screenV: centre.v, screenRadius: SCREEN_RADIUS,
      screenFraction: nOk ? nMem / nOk : 0,
      frameIntervalMs: rec.frameIntervalMs,
      validFraction: n ? nOk / n : 0,
      lidMedian: lidMed,
      blinksRemoved,
      missing: n ? {
        noFace: nNoFace / n, eyesOut: nEyesOut / n, olderAnalysis: nOlder / n,
        eyesClosed: Math.max(0, (n - nOk - nNoFace - nEyesOut - nOlder) / n),
      } : { noFace: 0, eyesOut: 0, eyesClosed: 0, olderAnalysis: 0 },
      brightened: n ? nBright / n : 0,
      distMedian: distMed,
      distRange: [pq(0.05), pq(0.95)],
      distMissing: nGaze ? nNoDist / nGaze : 0,
      distanceCorrected: useDist,
    },
  };
}

/**
 * Blinks drag the eye estimate downwards for a few frames as the lids close. A blink is a
 * stretch where the lids are below `lidFrac` of the usual opening (or the eyes were too
 * closed to measure) lasting no more than `maxMs`, widened by one frame each side to catch
 * the closing and reopening. Its eye values are replaced by a straight line between the
 * frames either side. Longer lid dips are left alone: looking down at the desk lowers the
 * lids too, and that is real gaze.
 */
export function removeBlinks(t: Float64Array, eH: Float32Array, eV: Float32Array, lid: Float32Array, breakBefore: Uint8Array,
  lidFrac: number, maxMs: number, out: Uint8Array): number {
  const n = t.length;
  let count = 0, k = 0;
  const closing = (i: number) => lid[i] < lidFrac || !Number.isFinite(lid[i]);
  while (k < n) {
    if (!closing(k)) { k++; continue; }
    let e = k;
    while (e + 1 < n && !breakBefore[e + 1] && closing(e + 1)) e++;
    const a = k > 0 && !breakBefore[k] ? k - 1 : k;           // pad one frame each side
    const b = e + 1 < n && !breakBefore[e + 1] ? e + 1 : e;
    const before = a > 0 && !breakBefore[a] ? a - 1 : -1;
    const after = b + 1 < n && !breakBefore[b + 1] ? b + 1 : -1;
    const dur = t[e] - t[k];
    if (dur <= maxMs && before >= 0 && after >= 0 && Number.isFinite(eH[before]) && Number.isFinite(eH[after])) {
      for (let i = a; i <= b; i++) {
        const f = (t[i] - t[before]) / (t[after] - t[before]);
        eH[i] = eH[before] + f * (eH[after] - eH[before]);
        eV[i] = eV[before] + f * (eV[after] - eV[before]);
        out[i] = 1;
      }
      count++;
    }
    k = e + 1;
  }
  return count;
}

/**
 * The angle at which the same target would be seen from the usual distance: a target at angle a
 * from distance d is tan(a)·d off the line of sight; from the usual distance D that is
 * atan(tan(a)·d/D). Assumes targets lie roughly in a plane through the camera facing the person
 * (laptop screen, a phone or notes beside it). Angles beyond ±85° are left alone.
 */
export function rescaleAngle(deg: number, ratio: number): number {
  if (!Number.isFinite(deg) || Math.abs(deg) > 85) return deg;
  return Math.atan(Math.tan((deg * Math.PI) / 180) * ratio) * 180 / Math.PI;
}

export function avg(a: number, b: number): number {
  const fa = Number.isFinite(a), fb = Number.isFinite(b);
  return fa && fb ? (a + b) / 2 : fa ? a : fb ? b : NaN;
}

function corr(a: Float32Array, b: Float32Array, mask: Uint8Array): number {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) if (mask[i] && Number.isFinite(a[i]) && Number.isFinite(b[i])) { n++; sa += a[i]; sb += b[i]; }
  if (n < 20) return NaN;
  const ma = sa / n, mb = sb / n;
  let cab = 0, caa = 0, cbb = 0;
  for (let i = 0; i < a.length; i++) if (mask[i] && Number.isFinite(a[i]) && Number.isFinite(b[i])) {
    const x = a[i] - ma, y = b[i] - mb; cab += x * y; caa += x * x; cbb += y * y;
  }
  return caa > 0 && cbb > 0 ? cab / Math.sqrt(caa * cbb) : NaN;
}

/** Peak of a smoothed 1° histogram over ±90°. */
export function densestPoint(h: Float32Array, v: Float32Array, ok: Uint8Array): { h: number; v: number } {
  const R = 90, N = 2 * R + 1;
  const g = new Float32Array(N * N);
  let any = false;
  for (let i = 0; i < h.length; i++) {
    if (!ok[i]) continue;
    const x = Math.round(h[i]) + R, y = Math.round(v[i]) + R;
    if (x < 0 || y < 0 || x >= N || y >= N) continue;
    g[y * N + x]++; any = true;
  }
  if (!any) return { h: 0, v: 0 };
  let sm: Float32Array = g;
  for (let pass = 0; pass < 3; pass++) sm = box(sm, N, 2);
  let best = 0, bi = 0;
  for (let i = 0; i < sm.length; i++) if (sm[i] > best) { best = sm[i]; bi = i; }
  return { h: (bi % N) - R, v: Math.floor(bi / N) - R };
}

function box(a: Float32Array, N: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < N) s += a[y * N + xx]; } tmp[y * N + x] = s;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < N) s += tmp[yy * N + x]; } out[y * N + x] = s;
  }
  return out;
}

function membership(h: Float32Array, v: Float32Array, ok: Uint8Array, c: { h: number; v: number }, r: number): Uint8Array {
  const m = new Uint8Array(h.length);
  for (let i = 0; i < h.length; i++) m[i] = ok[i] && Math.hypot(h[i] - c.h, v[i] - c.v) <= r ? 1 : 0;
  return m;
}

/**
 * Within screen fixations, E = (target − H)/k with the target (where on the screen they are
 * reading) independent of head posture. Regressing E on H gives slope −1/k without the
 * attenuation that the scatter of targets would cause if H were regressed on E:
 * k = −var(H)/cov(E,H).
 */
export function fitK(head: Float32Array, eye: Float32Array, mask: Uint8Array): { k: number; r: number; n: number; sdE: number } {
  let n = 0, se = 0, sh = 0;
  for (let i = 0; i < head.length; i++) if (mask[i] && Number.isFinite(head[i]) && Number.isFinite(eye[i])) { n++; se += eye[i]; sh += head[i]; }
  if (n < 30) return { k: NaN, r: NaN, n, sdE: 0 };
  const me = se / n, mh = sh / n;
  let cov = 0, ve = 0, vh = 0;
  for (let i = 0; i < head.length; i++) if (mask[i] && Number.isFinite(head[i]) && Number.isFinite(eye[i])) {
    const e = eye[i] - me, h = head[i] - mh; cov += e * h; ve += e * e; vh += h * h;
  }
  return { k: cov !== 0 ? -vh / cov : NaN, r: ve > 0 && vh > 0 ? cov / Math.sqrt(ve * vh) : NaN, n, sdE: Math.sqrt(ve / n) };
}

/** Why a fitted eye scale is not used, or "" if it is. */
function rejectReason(fit: { k: number; r: number; n: number }, prior: number): string {
  if (fit.n < 200) return "too few on-screen frames to fit";
  if (!Number.isFinite(fit.k) || Math.abs(fit.r) <= 0.3) return "head and eye movements too weakly related to fit";
  if (Math.sign(fit.k) !== Math.sign(prior) || Math.abs(fit.k) < 0.4 * Math.abs(prior) || Math.abs(fit.k) > 2.5 * Math.abs(prior))
    return `fitted value ${fit.k.toFixed(0)}°/unit implausible`;
  return "";
}

/** Median of on-screen values within ±window/2, on a 5 s grid, interpolated to every frame. */
function baseline(t: Float64Array, x: Float32Array, member: Uint8Array, windowMs: number, fallback: number): Float32Array {
  const n = t.length, out = new Float32Array(n).fill(fallback);
  if (!n) return out;
  const step = 5000, half = windowMs / 2;
  const t0 = t[0], t1 = t[n - 1];
  const grid: number[] = [], vals: number[] = [];
  let lo = 0, hi = 0;
  for (let g = t0; g <= t1 + step; g += step) {
    while (lo < n && t[lo] < g - half) lo++;
    while (hi < n && t[hi] <= g + half) hi++;
    const w: number[] = [];
    for (let i = lo; i < hi; i++) if (member[i]) w.push(x[i]);
    grid.push(g);
    vals.push(w.length >= 30 ? median(w) : NaN);
  }
  // Grid points without enough on-screen frames take the nearest point that has them, so a
  // posture change across a stretch without gaze carries over; the overall centre only if none do.
  const filled = vals.slice();
  for (let k = 0; k < vals.length; k++) {
    if (Number.isFinite(vals[k])) continue;
    let best = NaN;
    for (let d = 1; d < vals.length && !Number.isFinite(best); d++) {
      if (k - d >= 0 && Number.isFinite(vals[k - d])) best = vals[k - d];
      else if (k + d < vals.length && Number.isFinite(vals[k + d])) best = vals[k + d];
    }
    filled[k] = Number.isFinite(best) ? best : fallback;
  }
  for (let k = 0; k < vals.length; k++) vals[k] = filled[k];
  let g = 0;
  for (let i = 0; i < n; i++) {
    while (g < grid.length - 2 && t[i] > grid[g + 1]) g++;
    const a = grid[g], b = grid[g + 1] ?? a;
    const f = b > a ? Math.min(1, Math.max(0, (t[i] - a) / (b - a))) : 0;
    out[i] = vals[g] + f * ((vals[g + 1] ?? vals[g]) - vals[g]);
  }
  return out;
}

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Index of the last frame with t ≤ x (−1 if none). */
export function indexAt(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= x) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

export type { RecordingSettings };
