import type { GazeSeries } from "../analysis/gazeModel";
import { indexAt } from "../analysis/gazeModel";
import type { Interval } from "../analysis/intervals";
import type { Region } from "../store/types";
import type { LivePoint } from "../analysis/live";
import { cssVar, fitCanvas } from "./util";

export interface Rect { h0: number; h1: number; v0: number; v1: number }

export interface PlaneState {
  gaze: GazeSeries | null;
  scope: Interval | null;
  regions: Region[];
  playhead: number;
  timeBrush: Interval | null;
  planeBrush: Rect | null;
  draft: Rect | null;
  /** Image drawn at the camera position (current video frame). */
  inset: CanvasImageSource | null;
  insetAspect: number;
  showHeat: boolean;
  /** Frames counted in the heatmap. */
  heatScope: Interval | Interval[] | null;
  /** A note drawn at the top of the plane about what the heatmap shows. */
  heatHint: string;
  trailMs: number;
  /** Frames tracked live during playback, drawn when there is no saved analysis at the playhead. */
  live: { trail: LivePoint[]; point: LivePoint | null } | null;
  /** Regions can be selected, moved and resized. */
  editable: boolean;
  selectedRegion: string | null;
}

type Grab = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const CURSORS: Record<Grab, string> = { move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** Camera-centred azimuth/elevation plane. h positive = image right (the person's left), v positive = up. */
export class GazePlane {
  view = { h0: -60, h1: 60, v0: -50, v1: 30 };
  private heat: { key: string; cells: Float32Array; max: number } | null = null;
  private box = { x: 0, y: 0, s: 1 };
  private drag: { h: number; v: number } | null = null;
  private grab: { id: string; how: Grab; from: { h: number; v: number }; orig: Rect; moved: boolean } | null = null;
  private regions: Region[] = [];
  private editable = false;
  onRect?: (r: Rect | null) => void;
  /** A region is being moved or resized (called repeatedly), then finished. */
  onRegionDrag?: (id: string, r: Rect) => void;
  onRegionDone?: (id: string) => void;
  /** A region was clicked without moving it. */
  onRegionSelect?: (id: string) => void;
  /** A click (no drag) on the plane, in degrees. */
  onClick?: (p: { h: number; v: number }) => void;
  onDraft?: (r: Rect | null) => void;

  constructor(public canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const hit = this.editable ? this.hitRegion(e) : null;
      if (hit) {
        const r = this.regions.find((x) => x.id === hit.id)!;
        this.grab = { id: hit.id, how: hit.how, from: this.toDeg(e), orig: norm(r), moved: false };
        return;
      }
      this.drag = this.toDeg(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.grab) {
        const p = this.toDeg(e), g = this.grab;
        const dh = p.h - g.from.h, dv = p.v - g.from.v;
        if (Math.abs(dh) * this.box.s > 2 || Math.abs(dv) * this.box.s > 2) g.moved = true;
        if (!g.moved) return;
        const r = { ...g.orig };
        if (g.how === "move") { r.h0 += dh; r.h1 += dh; r.v0 += dv; r.v1 += dv; }
        if (g.how.includes("w")) r.h0 = Math.min(r.h1 - 1, g.orig.h0 + dh);
        if (g.how.includes("e")) r.h1 = Math.max(r.h0 + 1, g.orig.h1 + dh);
        if (g.how.includes("s")) r.v0 = Math.min(r.v1 - 1, g.orig.v0 + dv);
        if (g.how.includes("n")) r.v1 = Math.max(r.v0 + 1, g.orig.v1 + dv);
        this.onRegionDrag?.(g.id, roundRect(r));
        return;
      }
      if (!this.drag) {
        const hit = this.editable ? this.hitRegion(e) : null;
        canvas.style.cursor = hit ? CURSORS[hit.how] : "crosshair";
        return;
      }
      const p = this.toDeg(e);
      this.onDraft?.({ h0: this.drag.h, h1: p.h, v0: this.drag.v, v1: p.v });
    });
    canvas.addEventListener("pointerup", (e) => {
      if (this.grab) {
        const g = this.grab;
        this.grab = null;
        if (g.moved) this.onRegionDone?.(g.id); else this.onRegionSelect?.(g.id);
        return;
      }
      if (!this.drag) return;
      const p = this.toDeg(e);
      const r = { h0: Math.min(this.drag.h, p.h), h1: Math.max(this.drag.h, p.h), v0: Math.min(this.drag.v, p.v), v1: Math.max(this.drag.v, p.v) };
      this.drag = null;
      this.onDraft?.(null);
      if (r.h1 - r.h0 < 1.5 && r.v1 - r.v0 < 1.5) this.onClick?.(p); else this.onRect?.(r);
    });
  }

  /** Region edge, corner or inside under the pointer (smallest region wins). */
  private hitRegion(e: PointerEvent): { id: string; how: Grab } | null {
    const rc = this.canvas.getBoundingClientRect();
    const x = e.clientX - rc.left, y = e.clientY - rc.top;
    const X = (h: number) => this.box.x + (h - this.view.h0) * this.box.s;
    const Y = (v: number) => this.box.y + (this.view.v1 - v) * this.box.s;
    const tol = 7;
    let best: { id: string; how: Grab; area: number } | null = null;
    for (const reg of this.regions) {
      const r = norm(reg);
      const x0 = X(r.h0), x1 = X(r.h1), y0 = Y(r.v1), y1 = Y(r.v0);
      if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) continue;
      const nearW = Math.abs(x - x0) <= tol, nearE = Math.abs(x - x1) <= tol, nearN = Math.abs(y - y0) <= tol, nearS = Math.abs(y - y1) <= tol;
      let how: Grab = "move";
      if (nearN || nearS || nearW || nearE) how = ((nearN ? "n" : nearS ? "s" : "") + (nearW ? "w" : nearE ? "e" : "")) as Grab;
      else if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const area = (x1 - x0) * (y1 - y0) - (how !== "move" ? 1e9 : 0); // edges beat insides
      if (!best || area < best.area) best = { id: reg.id, how, area };
    }
    return best;
  }

  private toDeg(e: PointerEvent): { h: number; v: number } {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { h: this.view.h0 + (x - this.box.x) / this.box.s, v: this.view.v1 - (y - this.box.y) / this.box.s };
  }

  fitTo(g: GazeSeries | null) {
    if (!g || !g.n) { this.view = { h0: -60, h1: 60, v0: -50, v1: 30 }; return; }
    const hs: number[] = [], vs: number[] = [];
    for (let i = 0; i < g.n; i++) if (g.ok[i]) { hs.push(g.h[i]); vs.push(g.v[i]); }
    if (hs.length < 10) return;
    hs.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    const h0 = Math.min(-15, q(hs, 0.003) - 10), h1 = Math.max(15, q(hs, 0.997) + 10);
    const v0 = Math.min(-15, q(vs, 0.003) - 10), v1 = Math.max(15, q(vs, 0.997) + 10);
    this.view = { h0: Math.floor(h0 / 10) * 10, h1: Math.ceil(h1 / 10) * 10, v0: Math.floor(v0 / 10) * 10, v1: Math.ceil(v1 / 10) * 10 };
    this.heat = null;
  }

  invalidateHeat() { this.heat = null; }

  /**
   * The hotspot under or near a click: starting from the busiest heatmap cell within 4° of
   * the click, grows through neighbouring cells with at least 15% of that cell's count
   * (and at least 2 frames). Returns its bounding box plus 1°, or null if nothing is there.
   */
  hotspotAt(p: { h: number; v: number }): Rect | null {
    const H = this.heat, V = this.view;
    if (!H) return null;
    const nx = V.h1 - V.h0, ny = V.v1 - V.v0;
    const cx = Math.floor(p.h - V.h0), cy = Math.floor(V.v1 - p.v);
    let best = 0, bx = -1, by = -1;
    for (let y = cy - 4; y <= cy + 4; y++) for (let x = cx - 4; x <= cx + 4; x++) {
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const c = H.cells[y * nx + x];
      if (c > best) { best = c; bx = x; by = y; }
    }
    if (best < 3) return null;
    const thr = Math.max(2, 0.15 * best);
    const seen = new Uint8Array(nx * ny), stack = [[bx, by]];
    let x0 = bx, x1 = bx, y0 = by, y1 = by;
    seen[by * nx + bx] = 1;
    while (stack.length) {
      const [x, y] = stack.pop()!;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny || seen[yy * nx + xx]) continue;
        if (Math.abs(xx - bx) > 30 || Math.abs(yy - by) > 30) continue;
        seen[yy * nx + xx] = 1;
        if (H.cells[yy * nx + xx] >= thr) stack.push([xx, yy]);
      }
    }
    return { h0: V.h0 + x0 - 1, h1: V.h0 + x1 + 2, v0: V.v1 - y1 - 2, v1: V.v1 - y0 + 1 };
  }

  draw(st: PlaneState) {
    const { w, h, ctx } = fitCanvas(this.canvas);
    const V = this.view;
    const s = Math.min(w / (V.h1 - V.h0), h / (V.v1 - V.v0));
    const ox = (w - s * (V.h1 - V.h0)) / 2, oy = (h - s * (V.v1 - V.v0)) / 2;
    this.box = { x: ox, y: oy, s };
    const X = (hd: number) => ox + (hd - V.h0) * s;
    const Y = (vd: number) => oy + (V.v1 - vd) * s;
    const ink = cssVar("--ink"), muted = cssVar("--muted"), rule = cssVar("--rule"), field = cssVar("--field");

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = field;
    ctx.fillRect(ox, oy, s * (V.h1 - V.h0), s * (V.v1 - V.v0));

    // Grid every 10°.
    ctx.lineWidth = 1;
    ctx.strokeStyle = rule;
    ctx.fillStyle = muted;
    ctx.font = "11px system-ui, sans-serif";
    for (let a = Math.ceil(V.h0 / 10) * 10; a <= V.h1; a += 10) {
      ctx.beginPath(); ctx.moveTo(X(a) + 0.5, Y(V.v1)); ctx.lineTo(X(a) + 0.5, Y(V.v0)); ctx.stroke();
      if (a !== V.h0 && a !== V.h1) { ctx.textAlign = "center"; ctx.fillText(`${a}°`, X(a), Y(V.v0) - 4); }
    }
    for (let a = Math.ceil(V.v0 / 10) * 10; a <= V.v1; a += 10) {
      ctx.beginPath(); ctx.moveTo(X(V.h0), Y(a) + 0.5); ctx.lineTo(X(V.h1), Y(a) + 0.5); ctx.stroke();
      if (a !== V.v0 && a !== V.v1) { ctx.textAlign = "left"; ctx.fillText(`${a}°`, X(V.h0) + 4, Y(a) - 3); }
    }
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.fillText("Their right", X(V.h0) + 6, Y(V.v1) + 16);
    ctx.textAlign = "right"; ctx.fillText("Their left", X(V.h1) - 6, Y(V.v1) + 16);
    if (st.heatHint) { ctx.textAlign = "center"; ctx.fillStyle = ink; ctx.fillText(st.heatHint, (X(V.h0) + X(V.h1)) / 2, Y(V.v1) + 16); ctx.fillStyle = muted; }

    const g = st.gaze;
    // Heatmap of the scope.
    if (g && st.showHeat) {
      const sc = st.heatScope;
      const scKey = !sc ? "" : Array.isArray(sc) ? `${sc.length}:${sc[0]?.start}:${sc[sc.length - 1]?.end}` : `${sc.start}:${sc.end}`;
      const key = `${g.t.length}:${g.t[0]}:${g.h[0]}:${scKey}:${V.h0}:${V.h1}:${V.v0}:${V.v1}`;
      if (!this.heat || this.heat.key !== key) this.heat = buildHeat(g, st.heatScope, V, key);
      const H = this.heat;
      const nx = V.h1 - V.h0, ny = V.v1 - V.v0;
      const lm = Math.log1p(H.max);
      const heatRgb = cssVar("--heat");
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const c = H.cells[y * nx + x];
        if (!c) continue;
        ctx.globalAlpha = 0.12 + 0.78 * (Math.log1p(c) / lm);
        ctx.fillStyle = heatRgb;
        ctx.fillRect(X(V.h0 + x), Y(V.v1 - y), s + 0.5, s + 0.5);
      }
      ctx.globalAlpha = 1;
    }

    // Regions.
    this.regions = st.regions; this.editable = st.editable;
    for (const r of st.regions) {
      const x0 = X(Math.min(r.h0, r.h1)), x1 = X(Math.max(r.h0, r.h1)), y0 = Y(Math.max(r.v0, r.v1)), y1 = Y(Math.min(r.v0, r.v1));
      const sel = r.id === st.selectedRegion;
      ctx.strokeStyle = r.colour; ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (st.editable) {
        ctx.fillStyle = r.colour;
        for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) ctx.fillRect(hx - (sel ? 4 : 3), hy - (sel ? 4 : 3), sel ? 8 : 6, sel ? 8 : 6);
      }
      ctx.fillStyle = r.colour;
      ctx.font = "600 12px system-ui, sans-serif"; ctx.textAlign = "left";
      ctx.fillText(r.name, x0 + 4, y0 + 14);
    }

    // Camera position, with the current video frame.
    const aw = 18, ah = aw / (st.insetAspect || 4 / 3);
    const ix0 = X(-aw / 2), iy0 = Y(ah / 2);
    if (st.inset) {
      ctx.globalAlpha = 0.92;
      try { ctx.drawImage(st.inset, ix0, iy0, aw * s, ah * s); } catch { /* frame not ready */ }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ink; ctx.lineWidth = 1;
      ctx.strokeRect(ix0, iy0, aw * s, ah * s);
    }
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(X(0), Y(0), 5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ink; ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("camera", X(0), Y(-ah / 2) + 13);

    if (g) {
      // Screen centre from the model.
      ctx.strokeStyle = cssVar("--screen"); ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(X(g.model.screenH), Y(g.model.screenV), g.model.screenRadius * s, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);

      // Frames in the highlighted time range.
      if (st.timeBrush) {
        ctx.fillStyle = cssVar("--hilite");
        const a = Math.max(0, indexAt(g.t, st.timeBrush.start)), b = indexAt(g.t, st.timeBrush.end);
        for (let i = a; i <= b; i++) if (g.ok[i] && g.t[i] >= st.timeBrush.start) ctx.fillRect(X(g.h[i]) - 1.5, Y(g.v[i]) - 1.5, 3, 3);
      }

      // Trail around the playhead.
      const a = Math.max(0, indexAt(g.t, st.playhead - st.trailMs)), b = indexAt(g.t, st.playhead);
      if (b >= 0 && st.playhead - g.t[b] < 1000) {
        const trace = cssVar("--trace");
        ctx.lineWidth = 2; ctx.lineJoin = "round";
        for (let i = a + 1; i <= b; i++) {
          if (!g.ok[i] || !g.ok[i - 1] || g.breakBefore[i]) continue;
          ctx.globalAlpha = 0.15 + 0.85 * (1 - (st.playhead - g.t[i]) / st.trailMs);
          ctx.strokeStyle = trace;
          ctx.beginPath(); ctx.moveTo(X(g.h[i - 1]), Y(g.v[i - 1])); ctx.lineTo(X(g.h[i]), Y(g.v[i])); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (g.ok[b]) {
          ctx.fillStyle = trace; ctx.strokeStyle = cssVar("--panel"); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(X(g.h[b]), Y(g.v[b]), 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }

    if (st.live) {
      const c = cssVar("--live");
      const tr = st.live.trail.filter((p) => p.t <= st.playhead && p.t > st.playhead - st.trailMs);
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      for (let i = 1; i < tr.length; i++) {
        if (tr[i].t - tr[i - 1].t > 200) continue;
        ctx.globalAlpha = 0.15 + 0.85 * (1 - (st.playhead - tr[i].t) / st.trailMs);
        ctx.beginPath(); ctx.moveTo(X(tr[i - 1].h), Y(tr[i - 1].v)); ctx.lineTo(X(tr[i].h), Y(tr[i].v)); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      const p = st.live.point;
      if (p) {
        ctx.strokeStyle = c; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(X(p.h), Y(p.v), 7, 0, Math.PI * 2); ctx.stroke();
      }
    }

    for (const [r, dash] of [[st.planeBrush, [5, 4]], [st.draft, [2, 3]]] as const) {
      if (!r) continue;
      ctx.strokeStyle = cssVar("--hilite"); ctx.lineWidth = 2; ctx.setLineDash([...dash]);
      const x0 = X(Math.min(r.h0, r.h1)), x1 = X(Math.max(r.h0, r.h1)), y0 = Y(Math.max(r.v0, r.v1)), y1 = Y(Math.min(r.v0, r.v1));
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
  }
}

function buildHeat(g: GazeSeries, scope: Interval | Interval[] | null, V: { h0: number; h1: number; v0: number; v1: number }, key: string) {
  const list = !scope ? null : Array.isArray(scope) ? scope : [scope];
  const nx = V.h1 - V.h0, ny = V.v1 - V.v0;
  const cells = new Float32Array(nx * ny);
  let max = 1;
  for (let i = 0; i < g.n; i++) {
    if (!g.ok[i]) continue;
    if (list && !list.some((s) => g.t[i] >= s.start && g.t[i] < s.end)) continue;
    const x = Math.floor(g.h[i] - V.h0), y = Math.floor(V.v1 - g.v[i]);
    if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
    const c = ++cells[y * nx + x];
    if (c > max) max = c;
  }
  return { key, cells, max };
}

function norm(r: Rect): Rect {
  return { h0: Math.min(r.h0, r.h1), h1: Math.max(r.h0, r.h1), v0: Math.min(r.v0, r.v1), v1: Math.max(r.v0, r.v1) };
}
function roundRect(r: Rect): Rect {
  const q = (x: number) => Math.round(x * 2) / 2;
  return { h0: q(r.h0), h1: q(r.h1), v0: q(r.v0), v1: q(r.v1) };
}
