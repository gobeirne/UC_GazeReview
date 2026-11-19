import { ELSEWHERE, NONE, SCREEN, type GazeEvent } from "../analysis/events";
import { indexAt, type GazeSeries } from "../analysis/gazeModel";
import type { Interval } from "../analysis/intervals";
import type { Region, Segment } from "../store/types";
import type { Rect } from "./plane";
import { cssVar, fitCanvas, fmtTime } from "./util";

/** Whole-recording strip: segments, analysed coverage, playhead, the detail window. */
export class Overview {
  private drag: number | null = null;
  onSeek?: (t: number) => void;
  onWindow?: (w: Interval) => void;
  onSegment?: (id: string) => void;
  private lastSegs: { id: string; x0: number; x1: number }[] = [];
  private duration = 1;
  private width = 1;

  constructor(public canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); this.drag = this.toT(e); });
    canvas.addEventListener("pointerup", (e) => {
      if (this.drag === null) return;
      const t = this.toT(e);
      const a = Math.min(this.drag, t), b = Math.max(this.drag, t);
      const x = e.clientX - canvas.getBoundingClientRect().left;
      this.drag = null;
      if (b - a > this.duration / this.width * 4) { this.onWindow?.({ start: a, end: b }); return; }
      const y = e.clientY - canvas.getBoundingClientRect().top;
      const seg = y < 20 ? this.lastSegs.find((s) => x >= s.x0 && x <= s.x1) : undefined;
      if (seg) this.onSegment?.(seg.id); else this.onSeek?.(t);
    });
  }
  private toT(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((e.clientX - r.left) / r.width) * this.duration));
  }

  draw(duration: number, segments: Segment[], coverage: Interval[], playhead: number, win: Interval | null, selected: string | null) {
    const { w, h, ctx } = fitCanvas(this.canvas);
    this.duration = Math.max(1, duration); this.width = w;
    const X = (t: number) => (t / this.duration) * w;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar("--field"); ctx.fillRect(0, 22, w, h - 22);
    // Coverage.
    ctx.fillStyle = cssVar("--covered");
    for (const c of coverage) ctx.fillRect(X(c.start), 22, Math.max(1, X(c.end) - X(c.start)), h - 36);
    // Ticks every 5 or 10 minutes.
    const stepMin = this.duration > 3_600_000 ? 10 : 5;
    ctx.fillStyle = cssVar("--muted"); ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center";
    for (let m = 0; m * 60000 <= this.duration; m += stepMin) {
      ctx.fillRect(X(m * 60000), h - 14, 1, 4);
      ctx.textAlign = m === 0 ? "left" : "center";
      ctx.fillText(fmtTime(m * 60000, 0), X(m * 60000), h - 2);
    }
    // Segments.
    this.lastSegs = [];
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "left";
    for (const s of segments) {
      const x0 = X(s.start), x1 = Math.max(x0 + 3, X(s.end));
      ctx.fillStyle = s.id === selected ? cssVar("--accent") : cssVar("--seg");
      ctx.fillRect(x0, 4, x1 - x0, 14);
      if (s.approx) { ctx.strokeStyle = cssVar("--ink"); ctx.setLineDash([2, 2]); ctx.strokeRect(x0 + 0.5, 4.5, x1 - x0 - 1, 13); ctx.setLineDash([]); }
      ctx.fillStyle = cssVar("--on-accent");
      if (x1 - x0 > 30) ctx.fillText(s.label || "Segment", x0 + 3, 15, x1 - x0 - 6);
      this.lastSegs.push({ id: s.id, x0, x1 });
    }
    // Detail window.
    if (win) {
      ctx.strokeStyle = cssVar("--ink"); ctx.lineWidth = 1;
      ctx.strokeRect(X(win.start) + 0.5, 22.5, Math.max(2, X(win.end) - X(win.start)) - 1, h - 37);
    }
    ctx.fillStyle = cssVar("--playhead");
    ctx.fillRect(X(playhead) - 1, 0, 2, h - 14);
  }
}

export interface DetailState {
  gaze: GazeSeries | null;
  labels: Int16Array | null;
  events: GazeEvent[];
  regions: Region[];
  win: Interval;
  playhead: number;
  timeBrush: Interval | null;
  planeBrush: Rect | null;
  selectedEvent: number;
}

/** VNG-style traces of horizontal and vertical gaze against time, with region bars and events. */
export class Detail {
  private drag: number | null = null;
  private win: Interval = { start: 0, end: 1 };
  private width = 1;
  onSeek?: (t: number) => void;
  onBrush?: (b: Interval | null) => void;
  onDraft?: (b: Interval | null) => void;
  onZoom?: (w: Interval) => void;
  readonly pad = 70;

  constructor(public canvas: HTMLCanvasElement) {
    canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); this.drag = this.toT(e); });
    canvas.addEventListener("pointermove", (e) => {
      if (this.drag === null) return;
      const t = this.toT(e);
      this.onDraft?.({ start: Math.min(this.drag, t), end: Math.max(this.drag, t) });
    });
    canvas.addEventListener("pointerup", (e) => {
      if (this.drag === null) return;
      const t = this.toT(e), a = Math.min(this.drag, t), b = Math.max(this.drag, t);
      this.drag = null;
      this.onDraft?.(null);
      if (b - a > ((this.win.end - this.win.start) / this.width) * 4) this.onBrush?.({ start: a, end: b });
      else this.onSeek?.(t);
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const span = this.win.end - this.win.start;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.deltaX / this.width) * span;
        this.onZoom?.({ start: this.win.start + d, end: this.win.end + d });
        return;
      }
      const t = this.toT(e as unknown as PointerEvent);
      const f = Math.exp(e.deltaY * 0.0015);
      const ns = Math.max(500, span * f);
      const frac = (t - this.win.start) / span;
      this.onZoom?.({ start: t - frac * ns, end: t + (1 - frac) * ns });
    }, { passive: false });
  }

  private toT(e: { clientX: number }) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left - this.pad;
    return this.win.start + (x / Math.max(1, r.width - this.pad - 8)) * (this.win.end - this.win.start);
  }

  draw(st: DetailState, draftBrush: Interval | null) {
    const { w, h, ctx } = fitCanvas(this.canvas);
    this.win = st.win;
    const L = this.pad, R = w - 8, plotW = R - L;
    this.width = plotW;
    const span = st.win.end - st.win.start;
    const X = (t: number) => L + ((t - st.win.start) / span) * plotW;
    ctx.clearRect(0, 0, w, h);
    const muted = cssVar("--muted"), rule = cssVar("--rule");

    const laneH = Math.max(50, (h - 70) / 2);
    const lanes = [
      { name: "Horizontal", y: 6, key: "h" as const, colour: cssVar("--trace-h"), centre: st.gaze?.model.screenH ?? 0, up: "their left", down: "their right" },
      { name: "Vertical", y: 10 + laneH, key: "v" as const, colour: cssVar("--trace-v"), centre: st.gaze?.model.screenV ?? 0, up: "up", down: "down" },
    ];
    const bandY = 14 + 2 * laneH, bandH = 14, evY = bandY + bandH + 2;
    const range = 45; // ± degrees shown around the screen centre

    // Brushes.
    for (const [b, c] of [[st.timeBrush, "--hilite-soft"], [draftBrush, "--hilite-soft"]] as const) {
      if (!b) continue;
      ctx.fillStyle = cssVar(c);
      ctx.fillRect(X(b.start), 0, X(b.end) - X(b.start), h - 16);
    }

    ctx.font = "11px system-ui, sans-serif";
    for (const lane of lanes) {
      ctx.fillStyle = cssVar("--field"); ctx.fillRect(L, lane.y, plotW, laneH);
      const Y = (d: number) => lane.y + laneH / 2 - ((d - lane.centre) / range) * (laneH / 2);
      ctx.strokeStyle = rule; ctx.lineWidth = 1;
      for (const d of [-30, -15, 15, 30]) { const y = Y(lane.centre + d); ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(R, y + 0.5); ctx.stroke(); }
      ctx.strokeStyle = cssVar("--screen"); ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(L, Y(lane.centre) + 0.5); ctx.lineTo(R, Y(lane.centre) + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = muted; ctx.textAlign = "right";
      ctx.fillText(lane.up, L - 4, lane.y + 11); ctx.fillText(lane.down, L - 4, lane.y + laneH - 3);
      ctx.fillText("±15°", L - 4, Y(lane.centre + 15) + 4);
      ctx.save(); ctx.translate(12, lane.y + laneH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText(lane.name, 0, 0); ctx.restore();

      const g = st.gaze;
      if (!g) continue;
      ctx.save(); ctx.beginPath(); ctx.rect(L, lane.y, plotW, laneH); ctx.clip();
      ctx.strokeStyle = lane.colour; ctx.lineWidth = 1.4;
      const a = Math.max(0, indexAt(g.t, st.win.start) - 1), b = Math.min(g.n - 1, indexAt(g.t, st.win.end) + 1);
      const arr = g[lane.key];
      if (b - a > plotW * 3) {
        // Min/max per pixel column.
        let col = -1, mn = Infinity, mx = -Infinity;
        const flush = () => { if (col >= 0 && mn <= mx) { ctx.beginPath(); ctx.moveTo(L + col + 0.5, Y(mx)); ctx.lineTo(L + col + 0.5, Y(mn) + 1); ctx.stroke(); } };
        for (let i = a; i <= b; i++) {
          if (!g.ok[i]) continue;
          const c = Math.floor(X(g.t[i]) - L);
          if (c !== col) { flush(); col = c; mn = Infinity; mx = -Infinity; }
          mn = Math.min(mn, arr[i]); mx = Math.max(mx, arr[i]);
        }
        flush();
      } else {
        ctx.beginPath();
        let pen = false;
        for (let i = a; i <= b; i++) {
          if (!g.ok[i] || g.breakBefore[i]) { pen = false; if (!g.ok[i]) continue; }
          const x = X(g.t[i]), y = Y(arr[i]);
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          pen = true;
        }
        ctx.stroke();
        if (span < 20000) {
          ctx.fillStyle = lane.colour;
          for (let i = a; i <= b; i++) if (g.ok[i]) ctx.fillRect(X(g.t[i]) - 1.5, Y(arr[i]) - 1.5, 3, 3);
        }
      }
      ctx.restore();
    }

    // Region band and no-data shading.
    ctx.fillStyle = cssVar("--field"); ctx.fillRect(L, bandY, plotW, bandH);
    const g = st.gaze, lab = st.labels;
    if (g && lab) {
      const a = Math.max(0, indexAt(g.t, st.win.start)), b = indexAt(g.t, st.win.end);
      const dt = g.model.frameIntervalMs;
      const screenC = cssVar("--screen"), elseC = cssVar("--elsewhere"), noneC = cssVar("--nodata");
      for (let i = a; i <= b; i++) {
        const l = lab[i];
        ctx.fillStyle = l === SCREEN ? screenC : l === ELSEWHERE ? elseC : l === NONE ? noneC : st.regions[l]?.colour ?? elseC;
        const x0 = X(g.t[i]), x1 = X(g.t[i] + dt);
        ctx.fillRect(x0, bandY, Math.max(1, x1 - x0), bandH);
      }
      if (st.planeBrush) {
        const r = st.planeBrush;
        ctx.fillStyle = cssVar("--hilite");
        for (let i = a; i <= b; i++) if (g.ok[i] && g.h[i] >= r.h0 && g.h[i] <= r.h1 && g.v[i] >= r.v0 && g.v[i] <= r.v1) {
          ctx.fillRect(X(g.t[i]), 0, Math.max(1, X(g.t[i] + dt) - X(g.t[i])), 5);
        }
      }
    }
    ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.fillText("where", L - 4, bandY + 11);

    // Events.
    st.events.forEach((ev, i) => {
      if (ev.end < st.win.start || ev.start > st.win.end) return;
      ctx.fillStyle = i === st.selectedEvent ? cssVar("--accent") : cssVar("--ink");
      const x0 = X(ev.start), x1 = Math.max(x0 + 2, X(ev.end));
      ctx.fillRect(x0, evY, x1 - x0, 5);
    });

    // Time axis.
    ctx.fillStyle = muted; ctx.textAlign = "center";
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
    const step = steps.find((s) => (s / span) * plotW > 70) ?? 600000;
    for (let t = Math.ceil(st.win.start / step) * step; t <= st.win.end; t += step) {
      ctx.fillRect(X(t), h - 16, 1, 4);
      ctx.fillText(fmtTime(t, step < 1000 ? 1 : 0), X(t), h - 3);
    }

    // Playhead.
    if (st.playhead >= st.win.start && st.playhead <= st.win.end) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.fillRect(X(st.playhead) - 1, 0, 2, h - 16);
    }
  }
}
