import { anchorTime, type Anchor, type Episode } from "../analysis/sequence";

export interface SequenceDrawOptions {
  anchor: Anchor;
  sort: "item" | "delay" | "exceptions";
  /** Window around the anchor (ms). */
  before: number;
  after: number;
  target: string;
  title?: string;
  subtitle?: string;
  statsLines?: string[];
  settingsLine?: string;
}

const C = {
  ink: "#17212b", muted: "#5d6a75", rule: "#d8dee3", field: "#f6f8f9", bg: "#ffffff",
  speech: "#3b6fd8", look: "#d08a1e", lookManual: "#a8580a", obscured: "rgba(93,106,117,0.35)", submit: "#2f9e57", submitSaved: "#2f9e57",
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const ANCHOR_NAME: Record<Anchor, string> = { speech: "end of speech", glance: "start of the look", submit: "submit" };

/** Rows in display order: by item, or by the time from the look to submit (rows without a look last). */
export function orderRows(eps: Episode[], sort: "item" | "delay" | "exceptions"): Episode[] {
  if (sort === "item") return eps;
  if (sort === "exceptions") {
    // Items without a look first (those with eyes obscured next), then not judged, then the rest, in item order.
    const rank = (e: Episode) => (!e.analysed && !e.looks.length ? 2 : !e.glance ? (e.obscured.length ? 1 : 0) : 3);
    return eps.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
  }
  const d = (e: Episode) => (e.glance ? e.submit - e.glance.end : Infinity);
  return eps.slice().sort((a, b) => d(a) - d(b));
}

/**
 * Draws the stacked rows: speech (blue bars), looks (amber lines; manual darker and dashed), eyes
 * obscured (grey), submit (green; solid when seen, outlined when it is the platform's save time),
 * each row shifted so the chosen anchor is at zero. Rows without the anchor stay, labelled.
 * Returns the rows' vertical extents for click handling.
 */
export function drawSequence(ctx: CanvasRenderingContext2D, w: number, h: number, eps: Episode[], o: SequenceDrawOptions): { y0: number; y1: number; e: Episode }[] {
  const font = (px: number, weight = 400) => { ctx.font = `${weight} ${px}px ${FONT}`; };
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  let top = 8;
  if (o.title) { ctx.fillStyle = C.ink; font(22, 650); ctx.textAlign = "left"; ctx.fillText(o.title, 24, 34); top = 44; }
  if (o.subtitle) { ctx.fillStyle = C.muted; font(14); ctx.fillText(o.subtitle, 24, top + 16); top += 26; }
  const statsH = o.statsLines ? o.statsLines.length * 19 + 16 : 0;
  font(12);
  const settings = o.settingsLine ? wrapLines(ctx, o.settingsLine, w - 84 - 16) : [];
  const footH = 70 + statsH + settings.length * 16 + (settings.length ? 8 : 0);
  const L = 84, R = w - 16, rowsTop = top + 10, rowsBottom = h - footH;
  const span = o.before + o.after;
  const X = (ms: number) => L + ((ms + o.before) / span) * (R - L);
  const rows = orderRows(eps, o.sort);
  const n = Math.max(1, rows.length), rowH = (rowsBottom - rowsTop) / n;
  ctx.fillStyle = C.field; ctx.fillRect(L, rowsTop, R - L, rowsBottom - rowsTop);
  // Grid every 5 s.
  ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.fillStyle = C.muted; font(12); ctx.textAlign = "center";
  for (let s = Math.ceil(-o.before / 5000) * 5000; s <= o.after; s += 5000) {
    ctx.beginPath(); ctx.moveTo(X(s) + 0.5, rowsTop); ctx.lineTo(X(s) + 0.5, rowsBottom); ctx.stroke();
    ctx.fillText(`${s / 1000}`, X(s), rowsBottom + 16);
  }
  font(13); ctx.fillText(`Time relative to the ${ANCHOR_NAME[o.anchor]} (s)`, (L + R) / 2, rowsBottom + 34);
  ctx.strokeStyle = C.ink; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(0), rowsTop); ctx.lineTo(X(0), rowsBottom); ctx.stroke(); ctx.setLineDash([]);

  const hits: { y0: number; y1: number; e: Episode }[] = [];
  const labelEvery = Math.max(1, Math.ceil(12 / rowH));
  ctx.save(); ctx.beginPath(); ctx.rect(L, rowsTop, R - L, rowsBottom - rowsTop); ctx.clip();
  rows.forEach((e, i) => {
    const y0 = rowsTop + i * rowH;
    hits.push({ y0, y1: y0 + rowH, e });
    const a = anchorTime(e, o.anchor);
    if (a === undefined) return;
    const x = (t: number) => X(t - a);
    // Item start (previous save) as a faint tick.
    ctx.fillStyle = C.rule; ctx.fillRect(x(e.from) - 0.5, y0 + rowH * 0.2, 1, rowH * 0.6);
    ctx.fillStyle = C.obscured;
    for (const s of e.obscured) ctx.fillRect(x(s.start), y0 + rowH * 0.1, Math.max(2, x(s.end) - x(s.start)), rowH * 0.8);
    ctx.fillStyle = C.speech;
    for (const s of e.speech) ctx.fillRect(x(s.start), y0 + rowH * 0.22, Math.max(2, x(s.end) - x(s.start)), rowH * 0.3);
    for (const l of e.looks) {
      ctx.strokeStyle = l.manual ? C.lookManual : C.look; ctx.lineWidth = Math.max(2, rowH * 0.18);
      if (l.manual) ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(x(l.start), y0 + rowH * 0.7); ctx.lineTo(Math.max(x(l.end), x(l.start) + 3), y0 + rowH * 0.7); ctx.stroke();
      ctx.setLineDash([]);
    }
    const sx = x(e.submit);
    if (e.submitSource === "seen") { ctx.fillStyle = C.submit; ctx.fillRect(sx - 1.5, y0 + 1, 3, rowH - 2); }
    else { ctx.strokeStyle = C.submitSaved; ctx.lineWidth = 1.5; ctx.strokeRect(sx - 2, y0 + 2, 4, rowH - 4); }
  });
  ctx.restore();
  // Labels and missing anchors.
  rows.forEach((e, i) => {
    const y0 = rowsTop + i * rowH, ym = y0 + rowH / 2;
    if (i % labelEvery === 0) {
      font(Math.min(13, Math.max(9, rowH * 0.7))); ctx.textAlign = "right";
      ctx.fillStyle = e.changed ? "#bb6624" : C.muted;
      ctx.fillText(e.label + (e.changed ? " *" : ""), L - 8, ym + 4);
    }
    if (!e.analysed && !e.looks.length) {
      ctx.fillStyle = C.muted; font(Math.min(12, Math.max(9, rowH * 0.6)), 400); ctx.textAlign = "left";
      ctx.fillText("gaze not analysed for this item", L + 8, ym + 4);
    } else if (anchorTime(e, o.anchor) === undefined) {
      ctx.fillStyle = C.muted; font(Math.min(12, Math.max(9, rowH * 0.6)), 400); ctx.textAlign = "left";
      ctx.fillText(o.anchor === "glance" ? (e.obscured.length ? "no look; eyes obscured" : "no look in this item") : o.anchor === "speech" ? "no speech before the look" : "", L + 8, ym + 4);
    }
  });
  // Legend.
  let lx = L; const ly = rowsBottom + 56;
  font(13); ctx.textAlign = "left";
  const key = (draw: (x: number) => void, text: string) => { draw(lx); ctx.fillStyle = C.ink; ctx.fillText(text, lx + 22, ly); lx += 22 + ctx.measureText(text).width + 20; };
  key((x) => { ctx.fillStyle = C.speech; ctx.fillRect(x, ly - 9, 16, 6); }, "speech");
  key((x) => { ctx.strokeStyle = C.look; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, ly - 5); ctx.lineTo(x + 16, ly - 5); ctx.stroke(); }, `look to ${o.target} (automatic)`);
  key((x) => { ctx.strokeStyle = C.lookManual; ctx.lineWidth = 3; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(x, ly - 5); ctx.lineTo(x + 16, ly - 5); ctx.stroke(); ctx.setLineDash([]); }, "look (marked by hand)");
  key((x) => { ctx.fillStyle = C.obscured; ctx.fillRect(x, ly - 11, 16, 12); }, "eyes obscured");
  key((x) => { ctx.fillStyle = C.submit; ctx.fillRect(x + 7, ly - 12, 3, 14); }, "submit seen");
  key((x) => { ctx.strokeStyle = C.submitSaved; ctx.lineWidth = 1.5; ctx.strokeRect(x + 6, ly - 12, 4, 14); }, "saved (platform time)");
  if (o.statsLines) {
    ctx.fillStyle = C.ink; font(14);
    o.statsLines.forEach((t, i) => ctx.fillText(t, L, ly + 28 + i * 19));
  }
  if (settings.length) { ctx.fillStyle = C.muted; font(12); settings.forEach((t, i) => ctx.fillText(t, L, h - 10 - (settings.length - 1 - i) * 16)); }
  return hits;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const t = line ? `${line} ${word}` : word;
    if (ctx.measureText(t).width > width && line) { out.push(line); line = word; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
