import { AFTER, BEFORE, BIN, comparePositions, compareSentence, groupEvents, itemPositions, median, periEvent, positionSentence, pText, SHUFFLES, type PeriResult } from "../analysis/periEvent";
import type { GazeEvent } from "../analysis/events";
import type { GazeSeries } from "../analysis/gazeModel";
import { contains, type Interval } from "../analysis/intervals";
import type { Recording, Region } from "../store/types";
import { answerLabel, checkTimeline, clockMs, clockStamp, previousAnswer, type StoredTimeline, type TimelineEvent } from "../timeline/eventTimeline";
import { looksLikeHtml, parseMoodleReview } from "../timeline/moodleReview";
import { cssVar, download, downloadBlob, esc, fitCanvas, fmtTime } from "./util";
import { classify, dwell, ELSEWHERE, findEvents, SCREEN } from "../analysis/events";
import { totalLength } from "../analysis/intervals";
import { drawFigure } from "../report/figure";
import { buildCsv, buildReportHtml, figureCaption, type EventRow, type ReportData } from "../report/report";

export interface TimelineHost {
  rec(): Recording | null;
  save(): Promise<void>;
  playhead(): number;
  seek(t: number): void;
  pause(): void;
  analysis(): { gaze: GazeSeries | null; labels: Int16Array | null; glances: GazeEvent[]; regions: Region[]; coverage: Interval[] };
  /** The gaze plane's current view, for the figure. */
  planeView(): { h0: number; h1: number; v0: number; v1: number };
  say(s: string): void;
  redraw(): void;
}

export interface TimelineMark { t: number; label: string; kind: TimelineEvent["change_type"]; selected: boolean }


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
    if (act === "export-figure" || act === "export-report" || act === "export-csv") this.exportReport(act);
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
    if (t.id === "tl-minframes" || t.id === "tl-lookmode" || t.id === "tl-window" || t.id === "tl-once") {
      const rec = this.host.rec();
      if (rec) {
        if (t.id === "tl-once") rec.settings.countOnce = t.checked;
        if (t.id === "tl-minframes") rec.settings.minRegionFrames = Number(t.value);
        else if (t.id === "tl-window") rec.settings.beforeWindowMs = Number(t.value);
        else rec.settings.lookMode = t.value as "standard" | "stretches";
        await this.host.save(); this.renderAnalysis(); this.host.redraw();
      }
    }
    if (t.id === "tl-minlook") {
      const rec = this.host.rec();
      if (rec) { rec.settings.minLookMs = Number(t.value); await this.host.save(); this.renderAnalysis(); this.host.redraw(); }
    }
  }

  // ---------- Exports ----------

  private reportData(): ReportData | null {
    const rec = this.host.rec();
    const { gaze, labels, glances, regions, coverage } = this.host.analysis();
    if (!rec?.timeline || !this.synced() || !gaze || !labels) { this.host.say("Analyse the video and line up the event timeline first."); return null; }
    if (rec.settings.lookMode !== "stretches" && !regions.some((r) => r.isScreen)) { this.host.say("No region is marked as the screen, so looks can’t be counted properly. Tick “Screen” for the screen region in the Regions panel, then export again."); return null; }
    const evs = rec.timeline.data.events;
    const times = evs.map((e) => this.videoTime(e));
    const sel = this.selectedLooks(glances, rec.settings.minLookMs);
    const { peri, groups, prevs, span } = this.computePeri(times, sel, coverage);
    const panelA = (this.box.querySelector<HTMLSelectElement>("#tl-panela")?.value ?? "staircase") as "aligned" | "staircase";
    const sortedSel = sel.slice().sort((a, b) => a.start - b.start);
    const others = this.otherLooks(glances).sort((a, b) => a.start - b.start);
    const staircase = {
      t0: span?.start ?? times[0], t1: span?.end ?? times[times.length - 1],
      rows: groups.map((g, i) => {
        const items = g.members.map((m) => evs[m]);
        const from = prevs ? prevs[i] : (i ? times[groups[i - 1].members[groups[i - 1].members.length - 1]] : span?.start ?? g.t - BEFORE);
        return {
          label: groupLabel(items), changed: items.some((e) => e.change_type === "revision"),
          from, to: g.t,
          looks: sortedSel.filter((l) => l.start > from && l.start <= g.t).map((l) => [l.start, l.end - l.start] as [number, number]),
          otherLooks: others.filter((l) => l.start > from && l.start <= g.t).map((l) => [l.start, l.end - l.start] as [number, number]),
        };
      }),
    };
    if (!peri.events) { this.host.say("No saved responses have the minute before them analysed yet, so there’s nothing to report."); return null; }
    const where = this.region === "any" ? "anywhere off the screen" : regions[Number(this.region)]?.name ?? "the region";
    const conds = [
      rec.settings.minLookMs ? `${rec.settings.minLookMs / 1000} s or longer` : "",
      rec.settings.minRegionFrames && this.region !== "any" ? `${rec.settings.minRegionFrames}+ frames in the region` : "",
      rec.settings.lookMode === "stretches" ? "counted as stretches" : "",
    ].filter(Boolean);
    const target = conds.length ? `${where} (${conds.join(", ")})` : where;
    const d = dwell(gaze, labels, -Infinity, Infinity);
    const ok = (() => { let n = 0; for (let k = 0; k < gaze.n; k++) n += gaze.ok[k]; return n; })();
    const named = regions.map((r, i) => ({ r, i })).filter(({ r }) => !r.isScreen);
    const rows: EventRow[] = evs.map((e, i) => {
      const t = times[i];
      const prev = previousAnswer(evs, i);
      const analysed = coverage.some((c) => t - BEFORE >= c.start - rec.frameIntervalMs && t <= c.end + rec.frameIntervalMs);
      const lastLook: Record<string, number | null> = {};
      for (const { r, i: ri } of named) {
        let best: number | null = null;
        for (const g of this.looksFor(glances)) if (g.region === ri && g.end - g.start >= rec.settings.minLookMs && (!rec.settings.minRegionFrames || (g.inRegion?.[ri] ?? 0) >= rec.settings.minRegionFrames) && g.start <= t && g.start >= t - BEFORE) best = best === null ? t - g.start : Math.min(best, t - g.start);
        lastLook[r.name] = best;
      }
      const change = e.change_type === "revision" ? `${prev ? answerLabel(prev, 20) : "?"} → ${answerLabel(e, 20)}` : e.change_type === "resave" ? "same again" : "first";
      return { event: e, videoMs: t, change, lastLook, analysed };
    });
    const usedGroups = peri.used.map((i) => groups[i].members.map((m) => evs[m]));
    const positions = itemPositions(staircase.rows, sel.map((g) => g.start), coverage, rec.frameIntervalMs);
    const otherPositions = others.length ? itemPositions(staircase.rows, others.map((g) => g.start), coverage, rec.frameIntervalMs) : undefined;
    const comparison = otherPositions ? comparePositions(positions.values, otherPositions.values) : undefined;
    const otherLabel = `elsewhere off the screen`;
    const compareText = comparison ? compareSentence(where, otherLabel, comparison) : "";
    const panelB = (this.box.querySelector<HTMLSelectElement>("#tl-panelb")?.value ?? "timeline") as "timeline" | "before";
    const caption = figureCaption(target, peri, panelA, positions) + (compareText ? " " + compareText : "");
    const fig = drawFigure({
      title: `Looks to ${target} around saved responses`,
      subtitle: `${rec.name} · ${peri.events} responses with the minute before analysed · ${(totalLength(coverage) / 60000).toFixed(1)} min of video analysed`,
      target, peri,
      rowLabels: usedGroups.map(groupLabel),
      rowChanged: usedGroups.map((g) => g.some((e) => e.change_type === "revision")),
      gaze, view: this.host.planeView(), regions, caption, panelA, staircase,
      heatSpan: rec.settings.countOnce !== false && span ? span : undefined,
      heatWindows: panelB === "before" ? this.beforeWindows() : undefined,
      positions: panelA === "staircase" ? positions : undefined, coverage,
      otherPositions: panelA === "staircase" ? otherPositions : undefined,
      regionStats: [
        ...regions.map((r, i) => ({ name: r.name, colour: r.colour, looks: r.isScreen ? null : glances.filter((g) => g.region === i).length, share: (d.get(r.isScreen ? SCREEN : i) ?? 0) / Math.max(1, ok * rec.frameIntervalMs) })),
        { name: "Elsewhere", colour: "#e07b00", looks: glances.filter((g) => g.region === ELSEWHERE).length, share: (d.get(ELSEWHERE) ?? 0) / Math.max(1, ok * rec.frameIntervalMs) },
      ],
    });
    return {
      rec, model: gaze.model, analysedMs: totalLength(coverage), gazeMs: ok * rec.frameIntervalMs,
      regions: regions.map((r, i) => ({ name: r.name, colour: r.colour, isScreen: r.isScreen, looks: glances.filter((g) => g.region === i).length, timeMs: d.get(r.isScreen ? SCREEN : i) ?? 0 })),
      unlabelledLooks: glances.filter((g) => g.region === ELSEWHERE).length,
      target, peri, rows,
      includeText: this.box.querySelector<HTMLInputElement>("#tl-include-text")?.checked ?? false,
      figurePng: fig.toDataURL("image/png"), caption, positions, compareText,
      // Kept for the PNG export.
      ...({ _canvas: fig } as object),
    } as ReportData;
  }

  private exportReport(kind: string) {
    const d = this.reportData();
    if (!d) return;
    const base = d.rec.name.replace(/[^\w.-]+/g, "_");
    if (kind === "export-figure") (d as unknown as { _canvas: HTMLCanvasElement })._canvas.toBlob((b) => b && downloadBlob(`${base}-looks-around-responses.png`, b), "image/png");
    if (kind === "export-report") download(`${base}-gaze-report.html`, buildReportHtml(d), "text/html");
    if (kind === "export-csv") download(`${base}-responses.csv`, buildCsv(d), "text/csv");
  }

  /** The window before each save moment (for the heatmap), once the timeline is lined up. */
  beforeWindows(): Interval[] {
    const rec = this.host.rec();
    if (!rec?.timeline || !this.synced()) return [];
    const w = rec.settings.beforeWindowMs ?? 10_000;
    return groupEvents(rec.timeline.data.events.map((e) => this.videoTime(e))).map((g) => ({ start: g.t - w, end: g.t }));
  }

  /** Looks away to anywhere except the chosen region (and never the screen), with the same length filters. */
  private otherLooks(glances: GazeEvent[]): GazeEvent[] {
    const s = this.host.rec()?.settings;
    if (this.region === "any" || !s) return [];
    const minFrames = s.minRegionFrames ?? 0;
    return this.looksFor(glances).filter((g) => String(g.region) !== this.region && g.end - g.start >= s.minLookMs && (!minFrames || g.frames >= minFrames));
  }

  /** The timeline's span in video time: from its start to its finish (or last event). */
  private span(): Interval | null {
    const tl = this.host.rec()?.timeline;
    if (!tl || !this.synced()) return null;
    const s = this.videoTime({ time: tl.data.attempt.started } as TimelineEvent);
    const lastEv = tl.data.events[tl.data.events.length - 1];
    const fin = this.videoTime({ time: tl.data.attempt.finished } as TimelineEvent);
    const e = Math.max(Number.isFinite(fin) ? fin : -Infinity, lastEv ? this.videoTime(lastEv) + AFTER : -Infinity);
    return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
  }

  /**
   * Saves at the same moment are merged; with "count each look once", each moment only counts looks
   * since the previous save (the first since the timeline's start), and chance placements stay within
   * the timeline's span, so the rest of the recording doesn't set the baseline.
   */
  private computePeri(times: number[], looks: GazeEvent[], coverage: Interval[]) {
    const rec = this.host.rec()!;
    const groups = groupEvents(times);
    const span = this.span();
    const once = rec.settings.countOnce !== false;
    const prevs = once ? groups.map((g, i) => (i ? times[groups[i - 1].members[groups[i - 1].members.length - 1]] : span?.start ?? NaN)) : undefined;
    const peri = periEvent(groups.map((g) => g.t), looks.map((g) => g.start), coverage, rec.frameIntervalMs, looks.map((g) => g.end - g.start),
      rec.settings.beforeWindowMs ?? 10_000, prevs, once && span ? span : undefined);
    return { peri, groups, prevs, span };
  }

  /** Looks as formed for this analysis: the app's looks, or "stretches" (every region treated as ordinary). */
  private looksFor(glances: GazeEvent[]): GazeEvent[] {
    const rec = this.host.rec();
    const { gaze, regions } = this.host.analysis();
    if (rec?.settings.lookMode !== "stretches" || !gaze) return glances;
    const key = `${gaze.n}:${gaze.t[0]}:${gaze.h[0]}:${JSON.stringify(regions)}:${rec.settings.minFrames}`;
    if (this.stretchCache?.key !== key) {
      const lab = classify(gaze, regions.map((r) => ({ ...r, isScreen: false })));
      this.stretchCache = { key, looks: findEvents(gaze, lab, rec.settings.minFrames) };
    }
    return this.stretchCache.looks;
  }
  private stretchCache: { key: string; looks: GazeEvent[] } | null = null;

  /** Looks to the chosen region (or anywhere off screen), lasting at least minMs, with enough frames in the region. */
  private selectedLooks(glances: GazeEvent[], minMs: number): GazeEvent[] {
    const s = this.host.rec()?.settings;
    const minFrames = s?.minRegionFrames ?? 0;
    return this.looksFor(glances).filter((g) =>
      (this.region === "any" || String(g.region) === this.region) &&
      g.end - g.start >= minMs &&
      (!minFrames || this.region === "any" || (g.inRegion?.[Number(this.region)] ?? 0) >= minFrames));
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
        <div class="row small"><label>Count looks to <select id="tl-region"></select></label>
          <label>lasting at least <select id="tl-minlook">${[[0, "any length"], [100, "0.1 s"], [200, "0.2 s"], [300, "0.3 s"], [500, "0.5 s"], [1000, "1 s"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label>with at least <select id="tl-minframes">${[0, 2, 3, 5, 7, 10].map((v) => `<option value="${v}">${v ? `${v} frames` : "any frames"}</option>`).join("")}</select> in the region</label>
          <label>Window before saves <select id="tl-window">${[5, 10, 15, 20, 30].map((v) => `<option value="${v * 1000}">${v} s</option>`).join("")}</select></label>
          <label class="check"><input type="checkbox" id="tl-once"> Count each look once, within the timeline</label>
          <label>Looks formed <select id="tl-lookmode"><option value="standard">as away from the screen</option><option value="stretches">as stretches, by most frames (earlier figures)</option></select></label></div>
        <canvas id="tl-hist" aria-label="Looks away before and after events"></canvas>
        <p id="tl-hist-note" class="small"></p>
        <div class="row">
          <button data-act="export-figure">Export figure (PNG)</button>
          <button data-act="export-report">Export report (HTML)</button>
          <button data-act="export-csv">Export responses (CSV)</button>
          <label class="small">Panel B <select id="tl-panelb"><option value="timeline">gaze during the timeline</option><option value="before">gaze in the window before each save</option></select></label>
          <label class="small">Panel A <select id="tl-panela"><option value="staircase">item by item against time</option><option value="aligned">aligned to each save, with histogram</option></select></label>
          <label class="check small"><input type="checkbox" id="tl-include-text"> Include item wording and responses</label>
        </div>
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
    const minLook = rec.settings.minLookMs;
    const chosen = this.selectedLooks(glances, minLook);
    const minSel = this.box.querySelector<HTMLSelectElement>("#tl-minlook");
    if (minSel) minSel.value = String(minLook);
    const mfSel = this.box.querySelector<HTMLSelectElement>("#tl-minframes");
    if (mfSel) mfSel.value = String(rec.settings.minRegionFrames ?? 0);
    const onceBox = this.box.querySelector<HTMLInputElement>("#tl-once");
    if (onceBox) onceBox.checked = rec.settings.countOnce !== false;
    const winSel = this.box.querySelector<HTMLSelectElement>("#tl-window");
    if (winSel) winSel.value = String(rec.settings.beforeWindowMs ?? 10_000);
    const modeSel = this.box.querySelector<HTMLSelectElement>("#tl-lookmode");
    if (modeSel) modeSel.value = rec.settings.lookMode ?? "standard";
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
        for (const g of chosen) if (g.start <= t && g.start >= t - BEFORE) best = Math.max(best, g.start);
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
    if (rec.settings.lookMode !== "stretches" && regions.length && !regions.some((r) => r.isScreen)) {
      this.drawHist(null);
      const note = this.box.querySelector("#tl-hist-note");
      if (note) note.innerHTML = `<span class="warn-line">No region is marked as the screen, so looks can’t be counted. Tick “Screen” for the screen region in the Regions panel.</span>`;
      return;
    }
    const cp = this.computePeri(evs.map((e) => this.videoTime(e)), chosen, coverage);
    this.drawHist(cp.peri);
    const times = evs.map((e) => this.videoTime(e));
    const items = cp.groups.map((g, i) => ({ from: cp.prevs ? cp.prevs[i] : (i ? times[cp.groups[i - 1].members[cp.groups[i - 1].members.length - 1]] : (cp.span?.start ?? g.t - BEFORE)), to: g.t }));
    const pos = itemPositions(items, chosen.map((g) => g.start), coverage, dt);
    const note = this.box.querySelector("#tl-hist-note");
    const where = this.region === "any" ? "anywhere off the screen" : regions[Number(this.region)]?.name ?? "the region";
    const oth = this.otherLooks(glances);
    const othPos = oth.length ? itemPositions(items, oth.map((g) => g.start), coverage, dt) : null;
    const cmp = othPos && pos.items ? compareSentence(where, "elsewhere off the screen", comparePositions(pos.values, othPos.values)) : "";
    if (note && pos.items) note.innerHTML = `<strong>${esc(positionSentence(where, pos))}</strong>${cmp ? `<br><strong>${esc(cmp)}</strong>` : ""}<br>` + note.innerHTML;
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
    const lat = median(h.latencies);
    note.innerHTML = `<strong>${h.eventsWithLook} of ${h.events} save moments</strong> had a look in the ${h.windowMs / 1000} s before; with the events at random times in the analysed video, ${h.eventsWithLookMean.toFixed(1)} on average, and ${pText(h)}.` +
      (h.latencies.length ? ` Median time from the last look to the event: ${(lat / 1000).toFixed(1)} s.` : "") +
      `<br><span class="muted">Bars: looks starting in each 5 s bin. Line and band: the same looks around randomly placed events (mean and 95% range, ${SHUFFLES} placements). Counting looks rather than events (bursts count several times): ${h.looksBefore} in the ${h.windowMs / 1000} s before, chance range ${h.sumLo}–${h.sumHi}.</span>`;
  }
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

/** "Q12", or "Q30–Q32" / "Q4, Q9" for saves at the same moment. */
function groupLabel(g: { question_number: number }[]): string {
  const q = g.map((e) => e.question_number);
  if (q.length === 1) return `Q${q[0]}`;
  const consecutive = q.every((x, i) => i === 0 || x === q[i - 1] + 1);
  return consecutive ? `Q${q[0]}–Q${q[q.length - 1]}` : q.map((x) => `Q${x}`).join(", ");
}
