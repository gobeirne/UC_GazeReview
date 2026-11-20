import type { GazeEvent } from "../analysis/events";
import type { GazeSeries } from "../analysis/gazeModel";
import { contains, type Interval } from "../analysis/intervals";
import type { Recording, Region } from "../store/types";
import { answerLabel, checkTimeline, clockMs, clockStamp, previousAnswer, type StoredTimeline, type TimelineEvent } from "../timeline/eventTimeline";
import { looksLikeHtml, parseMoodleReview } from "../timeline/moodleReview";
import { cssVar, esc, fitCanvas, fmtTime } from "./util";

export interface TimelineHost {
  rec(): Recording | null;
  save(): Promise<void>;
  playhead(): number;
  seek(t: number): void;
  pause(): void;
  analysis(): { gaze: GazeSeries | null; glances: GazeEvent[]; regions: Region[]; coverage: Interval[] };
  say(s: string): void;
  redraw(): void;
}

export interface TimelineMark { t: number; label: string; kind: TimelineEvent["change_type"]; selected: boolean }

/** Window around each event for the histogram (ms) and its bin width. */
const BEFORE = 60_000, AFTER = 10_000, BIN = 5_000, SHUFFLES = 500;

/**
 * The event timeline panel: importing a timeline, setting how it lines up with the video,
 * the list of events, markers for the timelines, and a histogram of looks away around events.
 */
export class TimelinePanel {
  private selected = -1;
  private region = "any";
  private pasteOpen = false;
  private dateOrder: "dmy" | "mdy" = "dmy";

  constructor(private box: HTMLElement, private host: TimelineHost) {
    box.addEventListener("click", (e) => this.click(e));
    box.addEventListener("change", (e) => this.change(e));
  }

  // ---------- Times ----------

  private startMs(): number {
    const s = this.host.rec()?.sync?.startClock;
    return s ? clockMs(s) : NaN;
  }

  /** Video time of an event (ms), or NaN if the timeline isn't lined up yet. */
  videoTime(e: TimelineEvent): number {
    return clockMs(e.time) - this.startMs();
  }

  private events(): TimelineEvent[] { return this.host.rec()?.timeline?.data.events ?? []; }
  private synced(): boolean { return Number.isFinite(this.startMs()) && this.events().length > 0; }

  marks(): TimelineMark[] {
    if (!this.synced()) return [];
    return this.events().map((e, i) => ({ t: this.videoTime(e), label: `Q${e.question_number}`, kind: e.change_type, selected: i === this.selected }));
  }

  /** Line for the playback readout: the most recent event within 2 minutes. */
  readout(ph: number): string | null {
    if (!this.synced()) return null;
    let last: TimelineEvent | null = null;
    for (const e of this.events()) { const t = this.videoTime(e); if (t <= ph && ph - t < 120_000) last = e; }
    if (!last) return null;
    const ago = (ph - this.videoTime(last)) / 1000;
    return `Last event: Q${last.question_number} saved “${answerLabel(last, 30)}” ${ago < 1 ? "just now" : `${ago.toFixed(0)} s ago`}`;
  }

  // ---------- Import ----------

  async importText(text: string, fileName: string) {
    const rec = this.host.rec();
    if (!rec) return;
    try {
      let data: unknown;
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) data = JSON.parse(trimmed);
      else if (looksLikeHtml(trimmed)) data = parseMoodleReview(trimmed, this.dateOrder);
      else throw new Error("Expected an event timeline (JSON) or the HTML source of a review page.");
      const { data: d, warnings } = checkTimeline(data);
      if (rec.timeline && !confirm("Replace the event timeline already attached to this recording?")) return;
      const stored: StoredTimeline = { fileName, importedAt: Date.now(), data: d, warnings };
      rec.timeline = stored;
      rec.sync ??= { startClock: null, method: "", note: "" };
      this.selected = -1;
      this.pasteOpen = false;
      await this.host.save();
      this.host.say(`Event timeline attached: ${d.events.length} events from ${fmtClock(d.attempt.started)} to ${fmtClock(d.attempt.finished)}.` +
        (rec.sync.startClock ? "" : " Set when the video started to place them on the video."));
      this.render();
    } catch (e) {
      this.host.say(`Couldn’t read the event timeline: ${(e as Error).message}`);
    }
  }

  // ---------- Interaction ----------

  private async setStart(stamp: string | null, method: string) {
    const rec = this.host.rec();
    if (!rec) return;
    rec.sync = { startClock: stamp, method, note: rec.sync?.note ?? "" };
    await this.host.save();
    this.render();
    this.host.redraw();
  }

  private async click(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const rec = this.host.rec();
    if (!el || !rec) {
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-ev]");
      if (tr) this.select(parseInt(tr.dataset.ev!, 10));
      return;
    }
    const act = el.dataset.act;
    if (act === "import") this.box.querySelector<HTMLInputElement>("#tl-file")?.click();
    if (act === "paste") { this.pasteOpen = !this.pasteOpen; this.render(); }
    if (act === "paste-go") {
      const t = this.box.querySelector<HTMLTextAreaElement>("#tl-paste")?.value ?? "";
      await this.importText(t, "pasted");
    }
    if (act === "remove" && confirm("Remove the event timeline from this recording? (The video analysis is not affected.)")) {
      delete rec.timeline; delete rec.sync; this.selected = -1;
      await this.host.save(); this.render(); this.host.redraw();
    }
    if (act === "nudge") {
      const s = this.startMs();
      if (Number.isFinite(s)) await this.setStart(clockStamp(s + Number(el.dataset.ms)), "adjusted by hand");
    }
    if (act === "use-file-date" && rec.fileDateUtcMs) await this.setStart(localStamp(rec.fileDateUtcMs), "video file’s date (unconfirmed)");
    if (act === "use-timeline-start" && rec.timeline) await this.setStart(rec.timeline.data.attempt.started, "assumed to start with the timeline");
    if (act === "line-up") {
      const i = parseInt(this.box.querySelector<HTMLSelectElement>("#tl-lineup")?.value ?? "-1", 10);
      const ev = this.events()[i];
      if (!ev) return;
      await this.setStart(clockStamp(clockMs(ev.time) - Math.round(this.host.playhead())), `lined up: Q${ev.question_number} at video ${fmtTime(this.host.playhead())}`);
    }
  }

  private async change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === "tl-file" && t.files?.[0]) {
      const f = t.files[0]; t.value = "";
      await this.importText(await f.text(), f.name);
    }
    if (t.id === "tl-start") {
      const v = t.value.length === 16 ? t.value + ":00" : t.value;
      await this.setStart(Number.isFinite(clockMs(v)) ? v : null, "typed");
    }
    if (t.id === "tl-note") {
      const rec = this.host.rec();
      if (rec?.sync) { rec.sync.note = t.value; await this.host.save(); }
    }
    if (t.id === "tl-order") this.dateOrder = t.value as "dmy" | "mdy";
    if (t.id === "tl-region") { this.region = t.value; this.renderAnalysis(); }
  }

  select(i: number) {
    const ev = this.events()[i];
    if (!ev) return;
    this.selected = i;
    if (this.synced()) { this.host.pause(); this.host.seek(Math.max(0, this.videoTime(ev) - 10_000)); }
    this.box.querySelectorAll("tr[data-ev]").forEach((r) => r.classList.toggle("selected", r.getAttribute("data-ev") === String(i)));
    this.host.redraw();
  }

  // ---------- Rendering ----------

  render() {
    const rec = this.host.rec();
    const summary = this.box.querySelector("#tl-summary");
    const body = this.box.querySelector<HTMLElement>("#tl-body")!;
    if (!rec) { body.innerHTML = ""; return; }
    const tl = rec.timeline;
    if (summary) summary.textContent = tl ? `${tl.data.events.length} events · ${tl.fileName}` : "";
    const importBar = `<div class="row">
      <button data-act="import">${tl ? "Replace…" : "Import timeline…"}</button>
      <button data-act="paste">${this.pasteOpen ? "Hide paste box" : "Paste source…"}</button>
      <label class="small">Dates in pages are <select id="tl-order"><option value="dmy" ${this.dateOrder === "dmy" ? "selected" : ""}>day/month/year</option><option value="mdy" ${this.dateOrder === "mdy" ? "selected" : ""}>month/day/year</option></select></label>
      ${tl ? `<button data-act="remove" class="danger">Remove</button>` : ""}
      <input type="file" id="tl-file" accept=".json,.html,.htm,application/json,text/html" hidden>
    </div>
    ${this.pasteOpen ? `<div class="paste"><textarea id="tl-paste" rows="5" placeholder="Paste a timeline (JSON) or the HTML source of a Moodle attempt review page with its response histories"></textarea><button data-act="paste-go" class="primary">Read it</button></div>` : ""}`;
    if (!tl) {
      body.innerHTML = `<p class="muted">Attach timestamped events to show against the video: a response-history timeline (JSON, <code>moodle-quiz-response-timeline/v1</code>) or the saved HTML source of a Moodle attempt review page.</p>${importBar}`;
      return;
    }
    const a = tl.data.attempt;
    const start = rec.sync?.startClock ?? "";
    const synced = this.synced();
    const evs = tl.data.events;
    const offset = synced ? clockMs(a.started) - this.startMs() : NaN;
    const fileDate = rec.fileDateUtcMs ? localStamp(rec.fileDateUtcMs) : null;
    body.innerHTML = `
      ${tl.warnings.length ? `<ul class="warn">${tl.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <p class="small"><strong>${esc(a.quiz_title || "Timeline")}</strong> · ${fmtClock(a.started)} to ${fmtClock(a.finished)} · ${evs.length} events on ${new Set(evs.map((e) => e.question_number)).size} items</p>
      ${importBar}
      <div class="sync">
        <h4>Line up with the video</h4>
        <div class="row">
          <label>The video started at <input type="datetime-local" step="1" id="tl-start" value="${esc(start)}"></label>
          <span class="nudges">${[[-60000, "−1 min"], [-10000, "−10 s"], [-1000, "−1 s"], [1000, "+1 s"], [10000, "+10 s"], [60000, "+1 min"]].map(([ms, l]) => `<button data-act="nudge" data-ms="${ms}" ${synced ? "" : "disabled"}>${l}</button>`).join("")}</span>
        </div>
        <div class="row">
          <span>Or: when the video is at the moment of</span>
          <select id="tl-lineup">${evs.map((e, i) => `<option value="${i}">Q${e.question_number} ${e.change_type.replace("_", " ")} at ${e.time.slice(11)}</option>`).join("")}</select>
          <button data-act="line-up">this event happens here</button>
        </div>
        <div class="row small">
          ${fileDate ? `<button data-act="use-file-date">Use the video file’s date</button><span class="muted">${fmtClock(fileDate)} in this computer’s time zone; unconfirmed: it may be when the file was processed, not recorded.</span>` : ""}
          <button data-act="use-timeline-start">Video starts with the timeline</button>
        </div>
        <p class="${synced ? "small" : "warn-line"}">${synced
          ? `Timeline starts at video ${fmtTime(offset, 0)}${offset < 0 ? " (before the video began)" : ""}. Set: ${esc(rec.sync?.method || "")}.`
          : "Not lined up yet: events aren’t shown on the video until the video’s start time is set."}</p>
        <label class="small">Note <input id="tl-note" size="40" value="${esc(rec.sync?.note ?? "")}" placeholder="e.g. start time from the recording’s details, adjusted +12 s"></label>
      </div>
      <div class="tl-analysis" ${synced ? "" : "hidden"}>
        <h4>Looks away around events</h4>
        <div class="row small"><label>Count looks to <select id="tl-region"></select></label></div>
        <canvas id="tl-hist" aria-label="Looks away before and after events"></canvas>
        <p id="tl-hist-note" class="small"></p>
      </div>
      <div class="tl-table"></div>`;
    this.renderAnalysis();
  }

  /** Parts that depend on the gaze analysis: region choices, histogram, and the event list. */
  renderAnalysis() {
    const rec = this.host.rec();
    if (!rec?.timeline) return;
    const { gaze, glances, regions, coverage } = this.host.analysis();
    const sel = this.box.querySelector<HTMLSelectElement>("#tl-region");
    if (sel) {
      const opts = `<option value="any">anywhere off screen</option>` + regions.map((r, i) => r.isScreen ? "" : `<option value="${i}">${esc(r.name)}</option>`).join("");
      if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
      sel.value = [...sel.options].some((o) => o.value === this.region) ? this.region : "any";
      this.region = sel.value;
    }
    const looks = glances.filter((g) => this.region === "any" || String(g.region) === this.region).map((g) => g.start).sort((a, b) => a - b);
    const synced = this.synced();
    const evs = rec.timeline.data.events;
    const dt = rec.frameIntervalMs;
    // Event list.
    const rows = evs.map((e, i) => {
      const t = synced ? this.videoTime(e) : NaN;
      const prev = previousAnswer(evs, i);
      const change = e.change_type === "revision" ? `${esc(prev ? answerLabel(prev, 20) : "?")} → ${esc(answerLabel(e, 20))}` : e.change_type === "resave" ? "same again" : "first";
      let lastLook = "";
      if (synced && gaze && contains(coverage, t)) {
        let best = -1;
        for (const g of glances) if (g.start <= t && g.start >= t - BEFORE && (this.region === "any" || String(g.region) === this.region)) best = Math.max(best, g.start);
        if (best >= 0) {
          const g = glances.find((x) => x.start === best)!;
          lastLook = `−${((t - best) / 1000).toFixed(1)} s${g.region >= 0 ? `, ${esc(regions[g.region]?.name ?? "")}` : ""}`;
        } else lastLook = `<span class="muted">none in 60 s</span>`;
      } else if (synced) lastLook = `<span class="muted">not analysed</span>`;
      return `<tr data-ev="${i}" class="${i === this.selected ? "selected" : ""} ${e.change_type}" tabindex="0">
        <td class="num">${synced ? fmtTime(t, 0) : "–"}</td>
        <td class="num">${esc(e.time.slice(11))}</td>
        <td>Q${e.question_number}</td>
        <td class="ans" title="${esc(e.answer)}">${esc(answerLabel(e, 60))}</td>
        <td>${change}</td>
        <td class="num">${lastLook}</td></tr>`;
    }).join("");
    const table = this.box.querySelector(".tl-table");
    if (table) table.innerHTML = `<table><thead><tr><th>Video</th><th>Clock</th><th>Item</th><th>Saved</th><th>Change</th><th>Last look away before</th></tr></thead><tbody>${rows}</tbody></table>`;
    if (!synced || !gaze) { this.drawHist(null); return; }
    this.drawHist(periEvent(evs.map((e) => this.videoTime(e)), looks, coverage, dt));
  }

  private drawHist(h: PeriResult | null) {
    const cv = this.box.querySelector<HTMLCanvasElement>("#tl-hist");
    const note = this.box.querySelector("#tl-hist-note");
    if (!cv || !note) return;
    const { w, h: H, ctx } = fitCanvas(cv);
    ctx.clearRect(0, 0, w, H);
    if (!h || !h.events) {
      note.textContent = h ? "No events fall inside analysed parts of the video (each needs the minute before it and 10 s after analysed)." : "";
      return;
    }
    const L = 40, R = w - 10, T = 10, B = H - 22;
    const nb = h.observed.length;
    const max = Math.max(1, ...h.observed, ...h.hi);
    const X = (b: number) => L + (b / nb) * (R - L);
    const Y = (v: number) => B - (v / max) * (B - T);
    ctx.fillStyle = cssVar("--hilite-soft");
    for (let b = 0; b < nb; b++) ctx.fillRect(X(b), Y(h.hi[b]), X(b + 1) - X(b), Y(h.lo[b]) - Y(h.hi[b]));
    ctx.fillStyle = cssVar("--accent");
    for (let b = 0; b < nb; b++) ctx.fillRect(X(b) + 2, Y(h.observed[b]), X(b + 1) - X(b) - 4, B - Y(h.observed[b]));
    ctx.strokeStyle = cssVar("--hilite"); ctx.lineWidth = 2; ctx.beginPath();
    for (let b = 0; b < nb; b++) { ctx.moveTo(X(b), Y(h.mean[b])); ctx.lineTo(X(b + 1), Y(h.mean[b])); }
    ctx.stroke();
    const zero = X(BEFORE / BIN);
    ctx.strokeStyle = cssVar("--ink"); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(zero, T); ctx.lineTo(zero, B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = cssVar("--muted"); ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center";
    for (let s = -BEFORE; s <= AFTER; s += 10_000) ctx.fillText(`${s / 1000} s`, X((s + BEFORE) / BIN), H - 6);
    ctx.textAlign = "right";
    ctx.fillText(String(max), L - 6, T + 8); ctx.fillText("0", L - 6, B);
    const last = BEFORE / BIN - 2; // the two bins in the 10 s before
    const obs = h.observed[last] + h.observed[last + 1];
    const exp = h.mean[last] + h.mean[last + 1];
    const lo = h.sumLo, hi = h.sumHi;
    note.innerHTML = `Bars: looks away starting in each 5 s bin, around ${h.events} event${h.events === 1 ? "" : "s"} in analysed parts. Line and band: the same looks if the events had fallen at random times in the analysed video (mean and 95% range, ${SHUFFLES} shuffles). In the 10 s before events: ${obs} looks; ${exp.toFixed(1)} expected by chance (95% range ${lo}–${hi}).`;
  }
}

interface PeriResult { events: number; observed: number[]; mean: number[]; lo: number[]; hi: number[]; sumLo: number; sumHi: number }

/**
 * Counts look onsets in 5 s bins from 60 s before to 10 s after each event, for events whose
 * whole window was analysed, and compares with the same number of events placed at random
 * in the analysed video (windows also fully analysed).
 */
export function periEvent(eventTimes: number[], looks: number[], coverage: Interval[], frameMs: number): PeriResult {
  const nb = (BEFORE + AFTER) / BIN;
  const inside = (t: number) => coverage.some((c) => t - BEFORE >= c.start - frameMs && t + AFTER <= c.end + frameMs);
  const evs = eventTimes.filter((t) => Number.isFinite(t) && inside(t));
  const count = (times: number[]) => {
    const h = new Array(nb).fill(0);
    for (const t of times) {
      for (const l of looks) {
        const d = l - t + BEFORE;
        if (d >= 0 && d < BEFORE + AFTER) h[Math.floor(d / BIN)]++;
      }
    }
    return h;
  };
  const observed = count(evs);
  // Places where a window fits entirely inside analysed video.
  const spans = coverage.map((c) => ({ a: c.start + BEFORE, b: c.end - AFTER })).filter((s) => s.b > s.a);
  const total = spans.reduce((s, x) => s + (x.b - x.a), 0);
  const runs: number[][] = [];
  const sums: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  if (evs.length && total > 0) {
    for (let k = 0; k < SHUFFLES; k++) {
      const ts = evs.map(() => {
        let x = rnd() * total;
        for (const s of spans) { const len = s.b - s.a; if (x < len) return s.a + x; x -= len; }
        return spans[spans.length - 1].b;
      });
      const h = count(ts);
      runs.push(h);
      sums.push(h[nb - AFTER / BIN - 2] + h[nb - AFTER / BIN - 1]);
    }
  }
  const pct = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const mean = observed.map((_, b) => (runs.length ? runs.reduce((s, r) => s + r[b], 0) / runs.length : 0));
  const lo = observed.map((_, b) => pct(runs.map((r) => r[b]), 0.025));
  const hi = observed.map((_, b) => pct(runs.map((r) => r[b]), 0.975));
  return { events: evs.length, observed, mean, lo, hi, sumLo: pct(sums, 0.025), sumHi: pct(sums, 0.975) };
}

/** UTC ms → wall-clock stamp in this computer's time zone. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtClock(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})$/.exec(stamp);
  if (!m) return stamp;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}, ${m[4]}`;
}
