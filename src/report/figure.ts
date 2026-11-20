import { AFTER, BEFORE, BIN, JUST_BEFORE, SHUFFLES, type PeriResult } from "../analysis/periEvent";
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
}

// Fixed light palette: the figure is for documents and email, whatever the app's theme.
const C = {
  ink: "#17212b", muted: "#5d6a75", rule: "#d8dee3", field: "#f6f8f9",
  bar: "#1d5fa8", band: "rgba(0,153,184,0.16)", chance: "#0099b8", tick: "#17212b",
  window: "rgba(224,123,0,0.10)", changed: "#bb6624", heat: [29, 95, 168] as const,
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";

/** Draws the two-panel figure at 1600×1000 logical pixels, scaled for print. */
export function drawFigure(data: FigureData, scale = 2): HTMLCanvasElement {
  const W = 1600, H = 1000;
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

  drawPanelA(ctx, data, { x: 40, y: 100, w: 940, h: 720 }, font);
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
  ctx.fillStyle = C.window; ctx.fillRect(X(-JUST_BEFORE), rasterTop, X(0) - X(-JUST_BEFORE), rasterBottom - rasterTop);
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

  // Histogram with chance band.
  const nb = p.observed.length;
  const max = Math.max(1, ...p.observed, ...p.hi);
  const Y = (v: number) => histBottom - (v / max) * (histBottom - histTop);
  const XB = (bin: number) => L + (bin / nb) * (R - L);
  ctx.fillStyle = C.band;
  for (let i = 0; i < nb; i++) ctx.fillRect(XB(i), Y(p.hi[i]), XB(i + 1) - XB(i), Y(p.lo[i]) - Y(p.hi[i]));
  ctx.fillStyle = C.bar;
  for (let i = 0; i < nb; i++) ctx.fillRect(XB(i) + 3, Y(p.observed[i]), XB(i + 1) - XB(i) - 6, histBottom - Y(p.observed[i]));
  ctx.strokeStyle = C.chance; ctx.lineWidth = 2.5; ctx.beginPath();
  for (let i = 0; i < nb; i++) { ctx.moveTo(XB(i), Y(p.mean[i])); ctx.lineTo(XB(i + 1), Y(p.mean[i])); }
  ctx.stroke();
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, histBottom + 0.5); ctx.lineTo(R, histBottom + 0.5); ctx.stroke();
  ctx.fillStyle = C.muted; font(13); ctx.textAlign = "right";
  for (const v of niceTicks(max)) { ctx.fillText(String(v), L - 8, Y(v) + 4); ctx.fillRect(L - 4, Y(v), 4, 1); }
  ctx.save(); ctx.translate(b.x + 14, (histTop + histBottom) / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; font(14); ctx.fillText(`Looks per ${BIN / 1000} s`, 0, 0); ctx.restore();
  ctx.textAlign = "center"; font(13);
  for (let s = -BEFORE; s <= AFTER; s += 10_000) ctx.fillText(`${s / 1000}`, X(s), histBottom + 20);
  font(14); ctx.fillText("Time relative to the saved response (s)", (L + R) / 2, histBottom + 40);
  // Legend.
  font(13); ctx.textAlign = "left";
  const lx = L + 8, ly = histTop + 4;
  ctx.fillStyle = C.bar; ctx.fillRect(lx, ly, 14, 10); ctx.fillStyle = C.ink; ctx.fillText("observed", lx + 20, ly + 10);
  ctx.strokeStyle = C.chance; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(lx + 100, ly + 5); ctx.lineTo(lx + 114, ly + 5); ctx.stroke();
  ctx.fillStyle = C.band; ctx.fillRect(lx + 100, ly - 2, 14, 14);
  ctx.fillStyle = C.ink; ctx.fillText(`chance (mean, 95% range of ${SHUFFLES} random placements)`, lx + 120, ly + 10);
}

function drawPanelB(ctx: CanvasRenderingContext2D, d: FigureData, b: Box, font: FontFn) {
  ctx.fillStyle = C.ink; font(18, 650); ctx.textAlign = "left";
  ctx.fillText("B   Where gaze went (whole analysed video)", b.x, b.y + 12);
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
