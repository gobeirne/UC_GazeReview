import { AFTER, BEFORE, BIN, SHUFFLES, type PeriResult, type PositionResult } from "../analysis/periEvent";
import type { GazeSeries } from "../analysis/gazeModel";
import type { Region } from "../store/types";

export interface FigureData {
  title: string;
  subtitle: string;
  /** What the looks are to, e.g. "Phone" or "anywhere off the screen". */
  target: string;
  peri: PeriResult;
  /** Per counted event (same order as peri.raster): label such as "Q12", and whether it changed a response. */
  rowLabels: string[];
  rowChanged: boolean[];
  gaze: GazeSeries;
  view: { h0: number; h1: number; v0: number; v1: number };
  regions: Region[];
  /** Looks and share of time with gaze per region, listed under panel B. */
  regionStats?: { name: string; colour: string; looks: number | null; share: number }[];
  caption: string;
  /** Panel A as the aligned raster and histogram, or item by item against time ("staircase"). */
  panelA?: "aligned" | "staircase";
  staircase?: { t0: number; t1: number; rows: { label: string; changed: boolean; from: number; to: number; looks: [number, number][]; otherLooks?: [number, number][] }[] };
  /** Positions of looks elsewhere off the screen, shown beside the target's. */
  otherPositions?: PositionResult;
  /** Panel B heatmap only from these windows (e.g. the time before each save). */
  heatWindows?: { start: number; end: number }[];
  /** Only frames in this video span go into panel B's heatmap. */
  heatSpan?: { start: number; end: number };
  /** Where in each item looks fall (staircase panel). */
  positions?: PositionResult;
  /** Analysed parts of the video, to show unanalysed time on the staircase. */
  coverage?: { start: number; end: number }[];
}

// Fixed light palette: the figure is for documents and email, whatever the app's theme.
const C = {
  ink: "#17212b", muted: "#5d6a75", rule: "#d8dee3", field: "#f6f8f9",
  bar: "#1d5fa8", band: "rgba(0,153,184,0.16)", chance: "#0099b8", tick: "#17212b",
  window: "rgba(224,123,0,0.10)", changed: "#bb6624", heat: [29, 95, 168] as const, other: "#e07b00",
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

/** Draws the two-panel figure at 1600×1080 logical pixels, scaled for print. */
export function drawFigure(data: FigureData, scale = 2): HTMLCanvasElement {
  const W = 1600, H = 1080;
  const cv = document.createElement("canvas");
  cv.width = W * scale; cv.height = H * scale;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  const font = (px: number, weight = 400) => { ctx.font = `${weight} ${px}px ${FONT}`; };

  ctx.fillStyle = C.ink; font(26, 650); ctx.textAlign = "left";
  ctx.fillText(data.title, 40, 44);
  ctx.fillStyle = C.muted; font(16);
  ctx.fillText(data.subtitle, 40, 70);

  if (data.panelA === "staircase" && data.staircase) drawStaircase(ctx, data, { x: 40, y: 100, w: 940, h: 720 }, font);
  else drawPanelA(ctx, data, { x: 40, y: 100, w: 940, h: 720 }, font);
  drawPanelB(ctx, data, { x: 1040, y: 100, w: 520, h: 720 }, font);

  // Caption.
  ctx.fillStyle = C.ink; font(15); ctx.textAlign = "left";
  wrap(ctx, data.caption, 40, 870, W - 80, 21);
  return cv;
}

type Box = { x: number; y: number; w: number; h: number };
type FontFn = (px: number, weight?: number) => void;

function drawPanelA(ctx: CanvasRenderingContext2D, d: FigureData, b: Box, font: FontFn) {
  const p = d.peri;
  const L = b.x + 70, R = b.x + b.w - 10;
  const X = (ms: number) => L + ((ms + BEFORE) / (BEFORE + AFTER)) * (R - L);
  const rasterTop = b.y + 30, rasterBottom = b.y + b.h * 0.6;
  const histTop = rasterBottom + 30, histBottom = b.y + b.h - 40;

  ctx.fillStyle = C.ink; font(18, 650); ctx.textAlign = "left";
  ctx.fillText(`A   Looks to ${d.target}, aligned to each saved response`, b.x, b.y + 12);

  // Raster.
  const n = Math.max(1, p.raster.length);
  const rowH = (rasterBottom - rasterTop) / n;
  ctx.fillStyle = C.field; ctx.fillRect(L, rasterTop, R - L, rasterBottom - rasterTop);
  ctx.fillStyle = C.window; ctx.fillRect(X(-p.windowMs), rasterTop, X(0) - X(-p.windowMs), rasterBottom - rasterTop);
  const labelEvery = Math.max(1, Math.ceil(12 / rowH));
  font(Math.min(13, Math.max(9, rowH * 0.8)));
  p.raster.forEach((row, i) => {
    const y0 = rasterTop + i * rowH, ym = y0 + rowH / 2;
    if (i % labelEvery === 0) {
      ctx.fillStyle = d.rowChanged[i] ? C.changed : C.muted; ctx.textAlign = "right";
      ctx.fillText(d.rowLabels[i] + (d.rowChanged[i] ? " *" : ""), L - 8, ym + 4);
    }
    ctx.fillStyle = C.tick;
    for (const [t, dur] of row) {
      const x0 = X(t), x1 = Math.min(X(AFTER), X(t + dur));
      ctx.fillRect(x0 - 1, y0 + rowH * 0.15, Math.max(3, x1 - x0 + 1), Math.max(2, rowH * 0.7));
    }
  });
  ctx.strokeStyle = C.ink; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0), rasterTop); ctx.lineTo(X(0), histBottom); ctx.stroke(); ctx.setLineDash([]);
  ctx.save(); ctx.translate(b.x + 14, (rasterTop + rasterBottom) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = C.muted; font(14); ctx.textAlign = "center";
  ctx.fillText(`Saved responses (${p.events}), in order`, 0, 0); ctx.restore();

  drawPeriHist(ctx, p, { L, R, top: histTop, bottom: histBottom, axisX: b.x + 14 }, font, true);
}

/** Looks per 5 s around saves, with the chance band. */
function drawPeriHist(ctx: CanvasRenderingContext2D, p: PeriResult, g: { L: number; R: number; top: number; bottom: number; axisX: number }, font: FontFn, wideLegend: boolean) {
  const { L, R } = g, histTop = g.top, histBottom = g.bottom;
  const X = (ms: number) => L + ((ms + BEFORE) / (BEFORE + AFTER)) * (R - L);
  const nb = p.observed.length;
  const max = Math.max(1, ...p.observed, ...p.hi);
  const Y = (v: number) => histBottom - (v / max) * (histBottom - histTop);
  const XB = (bin: number) => L + (bin / nb) * (R - L);
  ctx.fillStyle = C.band;
  for (let i = 0; i < nb; i++) ctx.fillRect(XB(i), Y(p.hi[i]), XB(i + 1) - XB(i), Y(p.lo[i]) - Y(p.hi[i]));
  ctx.fillStyle = C.bar;
  for (let i = 0; i < nb; i++) ctx.fillRect(XB(i) + 2, Y(p.observed[i]), XB(i + 1) - XB(i) - 4, histBottom - Y(p.observed[i]));
  ctx.strokeStyle = C.chance; ctx.lineWidth = 2.5; ctx.beginPath();
  for (let i = 0; i < nb; i++) { ctx.moveTo(XB(i), Y(p.mean[i])); ctx.lineTo(XB(i + 1), Y(p.mean[i])); }
  ctx.stroke();
  ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(0), histTop); ctx.lineTo(X(0), histBottom); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, histBottom + 0.5); ctx.lineTo(R, histBottom + 0.5); ctx.stroke();
  ctx.fillStyle = C.muted; font(12); ctx.textAlign = "right";
  for (const v of niceTicks(max)) { ctx.fillText(String(v), L - 8, Y(v) + 4); ctx.fillRect(L - 4, Y(v), 4, 1); }
  ctx.save(); ctx.translate(g.axisX, (histTop + histBottom) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; font(13); ctx.fillText(`Looks per ${BIN / 1000} s`, 0, 0); ctx.restore();
  ctx.textAlign = "center"; font(12);
  const step = wideLegend ? 10_000 : 20_000;
  for (let s = -BEFORE; s <= AFTER; s += step) ctx.fillText(`${s / 1000}`, X(s), histBottom + 16);
  font(13); ctx.fillText("Time relative to the save (s)", (L + R) / 2, histBottom + 33);
  font(12); ctx.textAlign = "left";
  const lx = L + 6, ly = histTop + 2;
  ctx.fillStyle = C.bar; ctx.fillRect(lx, ly, 12, 9); ctx.fillStyle = C.ink; ctx.fillText("observed", lx + 16, ly + 9);
  ctx.fillStyle = C.band; ctx.fillRect(lx + 80, ly - 2, 12, 13);
  ctx.strokeStyle = C.chance; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(lx + 80, ly + 4); ctx.lineTo(lx + 92, ly + 4); ctx.stroke();
  ctx.fillStyle = C.ink; ctx.fillText(wideLegend ? `chance (mean, 95% range of ${SHUFFLES} random placements)` : "chance (mean, 95% range)", lx + 98, ly + 9);
}

function drawPanelB(ctx: CanvasRenderingContext2D, d: FigureData, b: Box, font: FontFn) {
  ctx.fillStyle = C.ink; font(18, 650); ctx.textAlign = "left";
  ctx.fillText(d.heatWindows ? `B   Where gaze went in the ${d.peri.windowMs / 1000} s before each save` : d.heatSpan ? "B   Where gaze went (during the timeline)" : "B   Where gaze went (whole analysed video)", b.x, b.y + 12);
  const V = d.view, g = d.gaze;
  const top = b.y + 50, availH = b.h - 110;
  const s = Math.min(b.w / (V.h1 - V.h0), availH / (V.v1 - V.v0));
  const pw = s * (V.h1 - V.h0), ph = s * (V.v1 - V.v0);
  const ox = b.x + (b.w - pw) / 2, oy = top;
  const X = (h: number) => ox + (h - V.h0) * s, Y = (v: number) => oy + (V.v1 - v) * s;
  ctx.fillStyle = C.field; ctx.fillRect(ox, oy, pw, ph);
  // Heat (1° cells, log scale).
  const nx = V.h1 - V.h0, ny = V.v1 - V.v0, cells = new Float32Array(nx * ny);
  let max = 1;
  for (let i = 0; i < g.n; i++) {
    if (!g.ok[i]) continue;
    if (d.heatWindows) { if (!d.heatWindows.some((w) => g.t[i] >= w.start && g.t[i] < w.end)) continue; }
    else if (d.heatSpan && (g.t[i] < d.heatSpan.start || g.t[i] > d.heatSpan.end)) continue;
    const x = Math.floor(g.h[i] - V.h0), y = Math.floor(V.v1 - g.v[i]);
    if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
    max = Math.max(max, ++cells[y * nx + x]);
  }
  const lm = Math.log1p(max);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const c = cells[y * nx + x];
    if (!c) continue;
    ctx.fillStyle = `rgba(${C.heat[0]},${C.heat[1]},${C.heat[2]},${(0.12 + 0.8 * Math.log1p(c) / lm).toFixed(3)})`;
    ctx.fillRect(X(V.h0 + x), Y(V.v1 - y), s + 0.5, s + 0.5);
  }
  // Grid labels.
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.fillStyle = C.muted; font(12);
  for (let a = Math.ceil(V.h0 / 10) * 10; a <= V.h1; a += 10) {
    ctx.beginPath(); ctx.moveTo(X(a), oy); ctx.lineTo(X(a), oy + ph); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText(`${a}°`, X(a), oy + ph + 16);
  }
  for (let a = Math.ceil(V.v0 / 10) * 10; a <= V.v1; a += 10) {
    ctx.beginPath(); ctx.moveTo(ox, Y(a)); ctx.lineTo(ox + pw, Y(a)); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(`${a}°`, ox - 6, Y(a) + 4);
  }
  // Regions.
  for (const r of d.regions) {
    const x0 = X(Math.min(r.h0, r.h1)), x1 = X(Math.max(r.h0, r.h1)), y0 = Y(Math.max(r.v0, r.v1)), y1 = Y(Math.min(r.v0, r.v1));
    ctx.strokeStyle = r.colour; ctx.lineWidth = 2.5; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    font(14, 650); ctx.textAlign = "left";
    const tw = ctx.measureText(r.name).width;
    ctx.fillStyle = "rgba(255,255,255,0.88)"; ctx.fillRect(x0 + 2, y0 - 20, tw + 8, 18);
    ctx.fillStyle = r.colour; ctx.fillText(r.name, x0 + 6, y0 - 6);
  }
  // Camera.
  ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(0), Y(0), 6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = C.ink; font(12); ctx.textAlign = "center"; ctx.fillText("camera", X(0), Y(0) - 10);
  ctx.fillStyle = C.muted; font(14);
  ctx.textAlign = "left"; ctx.fillText("← their right", ox, oy + ph + 38);
  ctx.textAlign = "right"; ctx.fillText("their left →", ox + pw, oy + ph + 38);
  ctx.textAlign = "center"; ctx.fillText("Degrees from the camera, as seen from the camera", ox + pw / 2, oy + ph + 58);
  // Region summary.
  if (d.regionStats?.length) {
    let y = oy + ph + 92;
    font(14, 650); ctx.textAlign = "left"; ctx.fillStyle = C.ink;
    ctx.fillText("Region", b.x, y); ctx.textAlign = "right"; ctx.fillText("Looks", b.x + 330, y); ctx.fillText("Share of time", b.x + 440, y);
    font(14);
    for (const r of d.regionStats) {
      y += 22;
      if (y > b.y + b.h + 40) break;
      ctx.fillStyle = r.colour; ctx.fillRect(b.x, y - 11, 11, 11);
      ctx.fillStyle = C.ink; ctx.textAlign = "left"; ctx.fillText(r.name, b.x + 18, y);
      ctx.textAlign = "right"; ctx.fillText(r.looks == null ? "" : String(r.looks), b.x + 330, y);
      ctx.fillText(`${Math.round(r.share * 100)}%`, b.x + 440, y);
    }
  }
}

/**
 * Item by item against time: one row per save moment, a light bar from the previous save to this
 * one (the time spent on that item), the save as a dark line, and the looks during it as bars.
 * Answering in order gives a staircase from top left to bottom right.
 */
function drawStaircase(ctx: CanvasRenderingContext2D, d: FigureData, b: Box, font: FontFn) {
  const st = d.staircase!;
  const L = b.x + 90, R = b.x + b.w - 10, top = b.y + 30;
  const bottom = d.positions ? b.y + b.h * 0.62 : b.y + b.h - 50;
  const X = (t: number) => L + ((t - st.t0) / Math.max(1, st.t1 - st.t0)) * (R - L);
  ctx.fillStyle = C.ink; font(18, 650); ctx.textAlign = "left";
  ctx.fillText(`A   Looks to ${d.target}, item by item`, b.x, b.y + 12);
  const n = Math.max(1, st.rows.length), rowH = (bottom - top) / n;
  ctx.fillStyle = C.field; ctx.fillRect(L, top, R - L, bottom - top);
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.fillStyle = C.muted; font(13); ctx.textAlign = "center";
  const mins = (st.t1 - st.t0) / 60000;
  const step = mins > 60 ? 10 : mins > 20 ? 5 : mins > 8 ? 2 : 1;
  for (let m = 0; m <= mins; m += step) {
    const x = X(st.t0 + m * 60000);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillText(String(m), x, bottom + 16);
  }
  font(13); ctx.fillText("Minutes from the start of the timeline", (L + R) / 2, bottom + 33);
  const cov = d.coverage ?? [];
  const labelEvery = Math.max(1, Math.ceil(12 / rowH));
  st.rows.forEach((r, i) => {
    const y0 = top + i * rowH, h = Math.max(2, rowH * 0.7), yb = y0 + rowH * 0.15;
    // Time on the item: analysed parts blue, not analysed grey.
    ctx.fillStyle = "rgba(93,106,117,0.18)";
    ctx.fillRect(X(r.from), yb, Math.max(1, X(r.to) - X(r.from)), h);
    ctx.fillStyle = "rgba(29,95,168,0.32)";
    for (const c of cov) {
      const a = Math.max(c.start, r.from), e = Math.min(c.end, r.to);
      if (e > a) ctx.fillRect(X(a), yb, Math.max(1, X(e) - X(a)), h);
    }
    ctx.fillStyle = "rgba(224,123,0,0.28)";
    const ws = Math.max(r.from, r.to - d.peri.windowMs);
    ctx.fillRect(X(ws), yb, X(r.to) - X(ws), h);
    if (r.otherLooks) {
      ctx.fillStyle = C.other;
      for (const [t, dur] of r.otherLooks) ctx.fillRect(X(t) - 1, yb + h * 0.55, Math.max(2, X(t + dur) - X(t) + 1), h * 0.45);
    }
    ctx.fillStyle = C.tick;
    for (const [t, dur] of r.looks) ctx.fillRect(X(t) - 1, yb, Math.max(3, X(t + dur) - X(t) + 1), h);
    ctx.fillStyle = C.chance; ctx.fillRect(X(r.to) - 1, y0, 2.5, rowH);
    if (i % labelEvery === 0) {
      font(Math.min(13, Math.max(9, rowH * 0.8))); ctx.textAlign = "right";
      ctx.fillStyle = r.changed ? C.changed : C.muted;
      ctx.fillText(r.label + (r.changed ? " *" : ""), L - 8, y0 + rowH / 2 + 4);
    }
  });
  // Legend, spaced by measured text.
  font(13); ctx.textAlign = "left";
  let lx = L; const ly = bottom + 54;
  const key = (draw: (x: number) => void, text: string) => { draw(lx); ctx.fillStyle = C.ink; ctx.fillText(text, lx + 20, ly); lx += 20 + ctx.measureText(text).width + 22; };
  key((x) => { ctx.fillStyle = "rgba(29,95,168,0.32)"; ctx.fillRect(x, ly - 10, 14, 10); }, "time on the item");
  if (cov.length) key((x) => { ctx.fillStyle = "rgba(93,106,117,0.18)"; ctx.fillRect(x, ly - 10, 14, 10); }, "not analysed");
  key((x) => { ctx.fillStyle = "rgba(224,123,0,0.28)"; ctx.fillRect(x, ly - 10, 14, 10); }, `last ${d.peri.windowMs / 1000} s`);
  key((x) => { ctx.fillStyle = C.tick; ctx.fillRect(x, ly - 10, 14, 10); }, `look to ${d.target.split(" (")[0]}`);
  if (d.otherPositions) key((x) => { ctx.fillStyle = C.other; ctx.fillRect(x, ly - 5, 14, 5); }, "look elsewhere");
  key((x) => { ctx.fillStyle = C.chance; ctx.fillRect(x + 6, ly - 12, 2.5, 14); }, "saved");

  // Below the staircase: where in each item the looks started (left), and looks around saves (right).
  const pr = d.positions;
  if (!pr) return;
  const hTop = bottom + 104, hBottom = b.y + b.h - 34;
  const mid = (L + R) / 2;
  const pL = L, pR = mid - 30;
  const op = d.otherPositions;
  // Two kinds of look on one scale: share of each kind's looks per bin (so different totals compare).
  const share = (bins: number[]) => { const t = bins.reduce((a, b) => a + b, 0) || 1; return bins.map((v) => (100 * v) / t); };
  const mainS = share(pr.bins), otherS = op ? share(op.bins) : null;
  const max = Math.max(10, ...mainS, ...(otherS ?? []), 10);
  const Y = (v: number) => hBottom - (v / max) * (hBottom - hTop);
  const XB = (i: number) => pL + (i / 10) * (pR - pL);
  ctx.fillStyle = C.ink; font(14, 650); ctx.textAlign = "left";
  ctx.fillText(`Where in its item each look started (% of looks)`, b.x, hTop - 14);
  ctx.fillText("Looks around saves (all items, aligned)", mid + 30, hTop - 14);
  const bw = (XB(1) - XB(0) - 4) / (otherS ? 2 : 1);
  ctx.fillStyle = C.bar;
  mainS.forEach((v, i) => ctx.fillRect(XB(i) + 2, Y(v), bw, hBottom - Y(v)));
  if (otherS) { ctx.fillStyle = C.other; otherS.forEach((v, i) => ctx.fillRect(XB(i) + 2 + bw, Y(v), bw, hBottom - Y(v))); }
  ctx.strokeStyle = C.chance; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(pL, Y(10)); ctx.lineTo(pR, Y(10)); ctx.stroke();
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pL, hBottom + 0.5); ctx.lineTo(pR, hBottom + 0.5); ctx.stroke();
  ctx.fillStyle = C.muted; font(12); ctx.textAlign = "right";
  for (const v of niceTicks(max)) ctx.fillText(String(v), pL - 8, Y(v) + 4);
  ctx.save(); ctx.translate(b.x + 30, (hTop + hBottom) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; font(13); ctx.fillText("% of looks", 0, 0); ctx.restore();
  ctx.textAlign = "center"; font(12);
  ctx.fillText("start", pL + 14, hBottom + 16); ctx.fillText("halfway", (pL + pR) / 2, hBottom + 16); ctx.fillText("saved", pR - 16, hBottom + 16);
  font(13); ctx.fillText("Position in the item", (pL + pR) / 2, hBottom + 33);
  ctx.textAlign = "left"; ctx.fillStyle = C.ink; font(12);
  let kx = pL + 6;
  const k2 = (colour: string, text: string, line = false) => {
    if (line) { ctx.strokeStyle = colour; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(kx, hTop + 6); ctx.lineTo(kx + 12, hTop + 6); ctx.stroke(); }
    else { ctx.fillStyle = colour; ctx.fillRect(kx, hTop + 2, 12, 9); }
    ctx.fillStyle = C.ink; ctx.fillText(text, kx + 16, hTop + 11); kx += 16 + ctx.measureText(text).width + 14;
  };
  k2(C.bar, d.target.split(" (")[0]);
  if (otherS) k2(C.other, "elsewhere");
  k2(C.chance, "even spread", true);
  drawPeriHist(ctx, d.peri, { L: mid + 70, R, top: hTop, bottom: hBottom, axisX: mid + 40 }, font, false);
}

function niceTicks(max: number): number[] {
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : Math.ceil(max / 50) * 10;
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineH: number) {
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > width && line) { ctx.fillText(line, x, y); y += lineH; line = word; }
      else line = test;
    }
    if (line) { ctx.fillText(line, x, y); y += lineH; }
  }
}
