/** ms → "m:ss.s" or "h:mm:ss.s". */
export function fmtTime(ms: number, decimals = 1): string {
  if (!Number.isFinite(ms)) return "–";
  const neg = ms < 0; ms = Math.abs(ms);
  const totalS = ms / 1000;
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const ss = s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return (neg ? "−" : "") + (h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`);
}

/** Accepts "75", "1:15", "1:15.5", "1:02:03". Returns ms or NaN. */
export function parseTime(s: string): number {
  const parts = s.trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return NaN;
  let total = 0;
  for (const p of parts) total = total * 60 + parseFloat(p);
  return parts.length > 3 ? NaN : total * 1000;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Resizes a canvas to its CSS box at device pixel ratio; returns CSS width/height. */
export function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D } {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: r.width, h: r.height, ctx };
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const REGION_COLOURS = ["#B4235A", "#0E7490", "#7C3AED", "#A16207", "#4338CA", "#BE123C", "#15803D"];
export const SCREEN_COLOUR = "#3F7D58";

export function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
