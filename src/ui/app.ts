import { MediaPipeFaceTracker } from "../tracking/MediaPipeFaceTracker";
import { classify, dwell, ELSEWHERE, findEvents, labelPoint, NONE, SCREEN, type GazeEvent } from "../analysis/events";
import { buildGaze, indexAt, type GazeSeries } from "../analysis/gazeModel";
import { LiveGaze, type LivePoint } from "../analysis/live";
import { LM } from "../tracking/landmarks";
import { Fingerprinter, measure, shiftRun, splitRun } from "../analysis/frame";
import { normalise, subtract, totalLength, union, type Interval } from "../analysis/intervals";
import { alignCapture, ScreenCapture, type Crop } from "../capture/capture";
import * as db from "../store/db";
import * as folder from "../store/folder";
import { DEFAULT_SETTINGS, newId, type Recording, type Region, type Run, type Segment } from "../store/types";
import { analyseGap, chooseDecoderConfig, fileIdentity, trackerClock } from "../video/analyse";
import { fileSource, indexWebm, medianFrameInterval, type ByteSource, type WebmIndex } from "../video/webm";
import { GazePlane, type Rect } from "./plane";
import { Detail, Overview } from "./timeline";
import { download, esc, fmtTime, parseTime, REGION_COLOURS, SCREEN_COLOUR } from "./util";

interface Busy { label: string; done: number; total: number; abort: AbortController }

export class App {
  private recordings: Recording[] = [];
  private rec: Recording | null = null;
  private runs: Run[] = [];
  private coverage: Interval[] = [];
  private gaze: GazeSeries | null = null;
  private labels: Int16Array | null = null;
  private events: GazeEvent[] = [];
  private file: File | null = null;
  private src: ByteSource | null = null;
  private index: WebmIndex | null = null;
  private videoUrl = "";
  private scopeSeg: string | null = null;
  private win: Interval = { start: 0, end: 60000 };
  private timeBrush: Interval | null = null;
  private timeDraft: Interval | null = null;
  private planeBrush: Rect | null = null;
  private planeDraft: Rect | null = null;
  private pendingRegion: Rect | null = null;
  private editRegionId: string | null = null;
  private dragMode: "highlight" | "region" = "highlight";
  private selectedEvent = -1;
  private eventFilter = "all";
  private busy: Busy | null = null;
  private tracker = new MediaPipeFaceTracker();
  private trackerReady: Promise<void> | null = null;
  private capture: ScreenCapture | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCrop: Crop | null = null;
  private capturing = false;
  private capturedPlayhead = 0;
  private captureFrame: HTMLCanvasElement | null = null;
  private planeFitted = false;
  private live = new LiveGaze();
  private liveLandmarks: { t: number; pts: { x: number; y: number }[] } | null = null;
  private lastLiveT = NaN;
  private lastAttemptPh = NaN;
  private prefs = loadPrefs();
  private lock = new RecordingLock();
  private sidecarTimer = 0;
  private sidecarLast = 0;
  private sidecarError = "";
  private message = "";

  private q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private video!: HTMLVideoElement;
  private plane!: GazePlane;
  private overview!: Overview;
  private detail!: Detail;

  constructor(private root: HTMLElement) {}

  async start() {
    this.root.innerHTML = TEMPLATE;
    this.video = this.q<HTMLVideoElement>("#video");
    this.plane = new GazePlane(this.q("#plane"));
    this.overview = new Overview(this.q("#overview"));
    this.detail = new Detail(this.q("#detail"));
    this.wire();
    db.setDbMessageHandler((m) => this.say(m));
    this.recordings = await db.listRecordings();
    this.renderRecordingList();
    db.requestPersistence();
    if (folder.folderSupported) { await folder.restoreFolder(); await this.renderFolder(); }
    if (typeof VideoDecoder === "undefined") this.say("This browser cannot decode video frame by frame (WebCodecs). Use a current Chrome, Edge, Firefox or Safari.");
    this.renderAll();
    // Track each frame as it is shown. Pending callbacks are dropped when the source changes,
    // so re-arm whenever a new source loads or playback starts.
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, m: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    if (v.requestVideoFrameCallback) {
      let handle = 0;
      const onFrame = (_now: number, m: { mediaTime: number }) => { handle = v.requestVideoFrameCallback!(onFrame); this.onVideoFrame(m.mediaTime * 1000); };
      const arm = () => { if (handle) v.cancelVideoFrameCallback?.(handle); handle = v.requestVideoFrameCallback!(onFrame); };
      for (const ev of ["loadeddata", "play"]) this.video.addEventListener(ev, arm);
    } else {
      this.video.addEventListener("timeupdate", () => this.trackCurrentFrame());
    }
    this.video.addEventListener("pause", () => this.trackCurrentFrame());
    this.video.muted = this.prefs.muted;
    this.video.volume = this.prefs.volume;
    this.q<HTMLInputElement>("#live-on").checked = this.prefs.live;
    this.q<HTMLInputElement>("#show-eyes").checked = this.prefs.eyes;
    this.q<HTMLInputElement>("#volume").value = String(this.prefs.volume);
    this.renderSound();
    const tick = () => { this.frame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new ResizeObserver(() => this.drawCanvases()).observe(this.root);
  }

  // ---------- Wiring ----------

  private wire() {
    const fileInput = this.q<HTMLInputElement>("#file-input");
    this.q("#open-file").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) this.openFile(f); });
    this.q<HTMLSelectElement>("#rec-select").addEventListener("change", (e) => this.selectRecording((e.target as HTMLSelectElement).value));
    this.q("#start-capture").addEventListener("click", () => this.beginCapture());
    this.q("#export").addEventListener("click", () => { const m = this.q("#export-menu"); m.hidden = !m.hidden; });
    this.q("#export-go").addEventListener("click", () => { this.q("#export-menu").hidden = true; this.exportRec(this.q<HTMLInputElement>("#export-thumbs").checked); });
    this.q("#export-cancel").addEventListener("click", () => { this.q("#export-menu").hidden = true; });
    this.q("#folder-btn").addEventListener("click", () => this.folderButton());
    this.q<HTMLSelectElement>("#folder-videos").addEventListener("change", async (e) => {
      const sel = e.target as HTMLSelectElement;
      const name = sel.value; sel.value = "";
      if (!name) return;
      const v = (await folder.listVideos()).find((x) => x.name === name);
      if (v) this.openFile(await v.handle.getFile());
    });
    const importInput = this.q<HTMLInputElement>("#import-input");
    this.q("#import").addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => { const f = importInput.files?.[0]; importInput.value = ""; if (f) this.importRec(await f.text()); });
    this.q("#rename").addEventListener("click", () => this.renameRec());
    this.q("#delete-rec").addEventListener("click", () => this.deleteRec());

    this.video.addEventListener("loadedmetadata", () => this.drawCanvases());
    this.video.addEventListener("seeked", () => { this.trackCurrentFrame(); this.drawCanvases(); });
    this.q("#play").addEventListener("click", () => this.togglePlay());
    this.q("#back-frame").addEventListener("click", () => this.stepFrames(-1));
    this.q("#fwd-frame").addEventListener("click", () => this.stepFrames(1));
    this.q<HTMLSelectElement>("#rate").addEventListener("change", (e) => { this.video.playbackRate = parseFloat((e.target as HTMLSelectElement).value); });
    this.q("#sound").addEventListener("click", () => { this.video.muted = !this.video.muted; this.prefs.muted = this.video.muted; savePrefs(this.prefs); this.renderSound(); });
    this.q<HTMLInputElement>("#volume").addEventListener("input", (e) => {
      this.video.volume = parseFloat((e.target as HTMLInputElement).value);
      if (this.video.muted && this.video.volume > 0) this.video.muted = false;
      this.prefs.volume = this.video.volume; this.prefs.muted = this.video.muted; savePrefs(this.prefs); this.renderSound();
    });
    for (const [id, key] of [["#live-on", "live"], ["#show-eyes", "eyes"]] as const) {
      this.q<HTMLInputElement>(id).addEventListener("change", (e) => {
        this.prefs[key] = (e.target as HTMLInputElement).checked; savePrefs(this.prefs);
        if (this.prefs.live || this.prefs.eyes) this.trackCurrentFrame();
      });
    }
    this.video.addEventListener("play", () => { if (this.prefs.live || this.prefs.eyes) this.ensureTracker().catch(() => {}); });

    this.plane.onDraft = (r) => { this.planeDraft = r; };
    this.plane.onRect = (r) => {
      if (this.dragMode === "region" && r) { this.pendingRegion = r; this.editRegionId = null; this.renderRegionForm(); return; }
      this.planeBrush = r;
      this.planeDraft = null;
    };
    this.plane.onClick = (p) => {
      if (this.dragMode === "region") {
        const r = this.plane.hotspotAt(p);
        if (!r) return this.say("There’s no hotspot there. Click on a busy part of the heatmap, or drag a box.");
        this.pendingRegion = r;
        this.editRegionId = null;
        this.renderRegionForm();
        return;
      }
      this.planeBrush = null;
    };
    this.root.querySelectorAll<HTMLInputElement>('input[name="dragmode"]').forEach((i) =>
      i.addEventListener("change", () => this.setDragMode(i.value as "highlight" | "region")));
    this.plane.onRegionDrag = (id, r) => {
      const reg = this.rec?.regions.find((x) => x.id === id);
      if (reg) Object.assign(reg, r, { auto: false });
      this.editRegionId = id;
      this.pendingRegion = null;
    };
    this.plane.onRegionDone = (id) => { this.editRegionId = id; this.renderRegionForm(); this.saveRec(); this.recompute(); };
    this.plane.onRegionSelect = (id) => { this.editRegionId = id; this.pendingRegion = null; this.renderRegionForm(); };
    this.q("#label-now").addEventListener("click", () => { this.video.pause(); this.labelLookingNow(); });
    this.q<HTMLSelectElement>("#heat-scope").addEventListener("change", () => { this.plane.invalidateHeat(); this.drawCanvases(); });
    this.q("#fit-plane").addEventListener("click", () => { this.plane.fitTo(this.gaze); this.drawCanvases(); });
    this.q("#clear-hl").addEventListener("click", () => { this.planeBrush = null; this.timeBrush = null; this.renderHeatScope(); this.drawCanvases(); });

    this.overview.onSeek = (t) => this.seek(t);
    this.overview.onWindow = (w) => { this.win = w; this.drawCanvases(); };
    this.overview.onSegment = (id) => this.setScope(id);
    this.detail.onSeek = (t) => this.seek(t);
    this.detail.onDraft = (b) => { this.timeDraft = b; };
    this.detail.onBrush = (b) => { this.timeBrush = b; this.renderHeatScope(); };
    this.detail.onZoom = (w) => { this.win = this.clampWin(w); };
    this.q("#zoom-scope").addEventListener("click", () => { this.win = this.scopeWindow(); });
    this.q("#zoom-in").addEventListener("click", () => this.zoom(0.5));
    this.q("#zoom-out").addEventListener("click", () => this.zoom(2));

    this.q("#seg-start-now").addEventListener("click", () => { this.q<HTMLInputElement>("#seg-start").value = fmtTime(this.playhead(), 0); });
    this.q("#seg-end-now").addEventListener("click", () => { this.q<HTMLInputElement>("#seg-end").value = fmtTime(this.playhead(), 0); });
    this.q("#seg-add").addEventListener("click", () => this.addSegment());
    this.q("#segments").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const id = b.dataset.id!;
      if (b.dataset.act === "scope") this.setScope(this.scopeSeg === id ? null : id);
      if (b.dataset.act === "analyse") this.analysePending();
      if (b.dataset.act === "delete") this.deleteSegment(id);
    });
    this.q("#scope-all").addEventListener("click", () => this.setScope(null));
    this.q("#stop-busy").addEventListener("click", () => this.busy?.abort.abort());

    this.q("#events").addEventListener("click", (e) => {
      const tr = (e.target as HTMLElement).closest("tr[data-i]") as HTMLElement | null;
      if (tr) this.selectEvent(parseInt(tr.dataset.i!, 10));
    });
    this.q<HTMLSelectElement>("#event-filter").addEventListener("change", (e) => { this.eventFilter = (e.target as HTMLSelectElement).value; this.renderEvents(); });

    this.q("#regions").addEventListener("change", (e) => this.regionEdit(e));
    this.q("#regions").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-act=delete]") as HTMLElement | null;
      if (b) this.deleteRegion(b.dataset.id!);
    });
    this.q("#settings").addEventListener("change", () => this.readSettings());

    document.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, select, textarea")) return;
      if (e.key === " ") { e.preventDefault(); this.togglePlay(); }
      else if (e.key === "," || e.key === "ArrowLeft") { e.preventDefault(); this.stepFrames(e.shiftKey ? -10 : -1); }
      else if (e.key === "." || e.key === "ArrowRight") { e.preventDefault(); this.stepFrames(e.shiftKey ? 10 : 1); }
      else if (e.key === "n") this.selectEvent(this.nextEvent(1));
      else if (e.key === "p") this.selectEvent(this.nextEvent(-1));
      else if (e.key === "Escape") { this.planeBrush = null; this.timeBrush = null; this.pendingRegion = null; this.editRegionId = null; this.renderRegionForm(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && this.editRegionId) { e.preventDefault(); this.deleteRegion(this.editRegionId); }
      else if (e.key === "l") { this.video.pause(); this.labelLookingNow(); }
    });
  }

  // ---------- Recordings ----------

  private renderRecordingList() {
    const sel = this.q<HTMLSelectElement>("#rec-select");
    sel.innerHTML = `<option value="">${this.recordings.length ? "Choose a saved recording…" : "No saved recordings"}</option>` +
      this.recordings.map((r) => `<option value="${r.id}" ${r.id === this.rec?.id ? "selected" : ""}>${esc(r.name)}${r.kind === "capture" ? " (screen capture)" : ""}</option>`).join("");
  }

  private async openFile(f: File) {
    if (this.busy) return this.say("Wait for the current analysis to finish or stop it first.");
    this.stopCapture();
    this.say(`Reading ${f.name}…`);
    try {
      const id = await fileIdentity(f);
      if (!(await this.lock.take(id))) return this.say(`${f.name} is already open in another window. Close it there first: two windows analysing the same video would overwrite each other.`);
      const src = fileSource(f);
      const ix = await indexWebm(src, (p) => this.say(`Indexing ${f.name}: ${Math.round(p * 100)}%`));
      const fromFolder = await this.loadSidecar(f.name, id);
      let rec = await db.getRecording(id);
      if (!rec) {
        rec = {
          id, name: f.name.replace(/\.[^.]+$/, ""), kind: "file", fileName: f.name, fileSize: f.size,
          durationMs: ix.durationMs, width: ix.width, height: ix.height, frameIntervalMs: medianFrameInterval(ix.frames),
          segments: [], regions: [], settings: { ...DEFAULT_SETTINGS }, createdAt: Date.now(), updatedAt: Date.now(),
        };
        await db.putRecording(rec);
        this.recordings = await db.listRecordings();
      }
      this.file = f; this.src = src; this.index = ix;
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = URL.createObjectURL(f);
      this.video.src = this.videoUrl;
      await this.loadRec(rec);
      const fps = 1000 / rec.frameIntervalMs;
      this.say(`${f.name}: ${ix.width}×${ix.height}, ${ix.codecId.replace("V_", "")}, about ${fps.toFixed(1)} frames/s, ${fmtTime(ix.durationMs, 0)} long, ${ix.frames.length.toLocaleString()} frames.` +
        (ix.skippedLaced ? ` ${ix.skippedLaced} laced blocks skipped.` : "") + (fromFolder ? ` ${fromFolder}` : ""));
    } catch (e) {
      this.say(`Could not open ${f.name}: ${(e as Error).message}`);
    }
  }

  private async selectRecording(id: string) {
    if (!id || this.busy) return;
    const rec = this.recordings.find((r) => r.id === id);
    if (!rec) return;
    if (!(await this.lock.take(id))) { this.renderRecordingList(); return this.say(`“${rec.name}” is already open in another window. Close it there first.`); }
    this.stopCapture();
    if (this.rec?.id !== id) {
      this.file = null; this.src = null; this.index = null;
      this.video.removeAttribute("src"); this.video.load();
    }
    await this.loadRec(rec);
    if (rec.kind === "file" && !this.file) this.say(`Open ${rec.fileName ?? "the video file"} to play the video or analyse more segments. Saved results are shown below.`);
  }

  private async loadRec(rec: Recording) {
    this.rec = rec;
    this.live.reset(); this.liveLandmarks = null; this.lastLiveT = NaN;
    rec.settings = { ...DEFAULT_SETTINGS, ...rec.settings };
    this.runs = await db.getRuns(rec.id);
    this.scopeSeg = null;
    this.timeBrush = null; this.planeBrush = null; this.selectedEvent = -1;
    this.recompute(true);
    this.win = this.scopeWindow();
    this.renderRecordingList();
    this.renderAll();
  }

  private async saveRec() {
    if (!this.rec) return;
    await db.putRecording(this.rec);
    this.recordings = await db.listRecordings();
    this.renderRecordingList();
    this.scheduleSidecar();
  }

  // ---------- Saving next to the videos ----------

  /** Writes the recording's file into the linked folder: 2 s after the last change, at most every 15 s. */
  private scheduleSidecar(now = false) {
    if (!folder.folderReady() || !this.rec) return;
    clearTimeout(this.sidecarTimer);
    const wait = now ? 0 : Math.max(2000, 15000 - (Date.now() - this.sidecarLast));
    this.sidecarTimer = window.setTimeout(() => this.writeSidecarNow(), wait);
  }

  private async writeSidecarNow() {
    const rec = this.rec;
    if (!rec || !folder.folderReady()) return;
    this.sidecarLast = Date.now();
    try {
      const runs = await db.getRuns(rec.id);
      await folder.writeSidecar(folder.sidecarName(rec.fileName ?? rec.name), db.exportJson(rec, runs, { thumbnails: true }));
      this.sidecarError = "";
    } catch (e) {
      this.sidecarError = `Could not save to the folder: ${(e as Error).message}`;
    }
    this.renderFolder();
  }

  /**
   * If the linked folder has a saved file for this video and it is newer than what this
   * browser has, use it. Returns a note for the status line, or "".
   */
  private async loadSidecar(fileName: string, id: string): Promise<string> {
    if (!folder.folderReady()) return "";
    const text = await folder.readSidecar(folder.sidecarName(fileName));
    if (!text) return "";
    try {
      const { recording, runs } = db.importJson(text);
      if (recording.id !== id) return `The folder’s ${folder.sidecarName(fileName)} belongs to a different video with the same name, so it was not used.`;
      const local = await db.getRecording(id);
      if (local && local.updatedAt >= recording.updatedAt) return "";
      if (local) await db.deleteRecording(id);
      await db.putRecording(recording);
      await db.putRuns(runs);
      this.recordings = await db.listRecordings();
      return `Earlier analysis loaded from ${folder.sidecarName(fileName)} in the folder.`;
    } catch (e) {
      return `The folder’s ${folder.sidecarName(fileName)} could not be read (${(e as Error).message}).`;
    }
  }

  private async folderButton() {
    try {
      if (folder.folderName() && !folder.folderReady()) await folder.reconnectFolder();
      else await folder.chooseFolder();
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.say(`Could not use that folder: ${(e as Error).message}`);
    }
    await this.renderFolder();
    if (folder.folderReady()) {
      this.say(`Analysis files will be saved in “${folder.folderName()}”, named after each video. Open videos from the list to pick up their saved analysis.`);
      this.scheduleSidecar(true);
    }
  }

  private async renderFolder() {
    const box = this.q("#folder"), btn = this.q<HTMLButtonElement>("#folder-btn"), sel = this.q<HTMLSelectElement>("#folder-videos");
    if (!folder.folderSupported) { box.hidden = true; return; }
    box.hidden = false;
    const name = folder.folderName(), ready = folder.folderReady();
    btn.textContent = !name ? "Save to a folder…" : ready ? "Change folder…" : `Reconnect “${name}”`;
    const status = this.q("#folder-status");
    status.textContent = this.sidecarError || (ready ? `Saving to “${name}”` + (this.sidecarLast ? `, last ${new Date(this.sidecarLast).toLocaleTimeString()}` : "") : "");
    status.classList.toggle("error", !!this.sidecarError);
    sel.hidden = !ready;
    if (ready) {
      const vids = await folder.listVideos();
      sel.innerHTML = `<option value="">Videos in this folder (${vids.length})…</option>` +
        vids.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}${v.analysed ? " ✓" : ""}</option>`).join("");
    }
  }

  private async renameRec() {
    if (!this.rec) return;
    const name = prompt("Recording name", this.rec.name);
    if (name && name.trim()) { this.rec.name = name.trim(); await this.saveRec(); this.renderAll(); }
  }

  private async deleteRec() {
    if (!this.rec || this.busy) return;
    if (!confirm(`Delete all saved analysis for “${this.rec.name}”? The video file itself is not affected.`)) return;
    await db.deleteRecording(this.rec.id);
    this.rec = null; this.runs = []; this.gaze = null; this.labels = null; this.events = []; this.coverage = [];
    this.recordings = await db.listRecordings();
    this.renderRecordingList(); this.renderAll();
  }

  private exportRec(thumbnails: boolean) {
    if (!this.rec) return;
    download(`${this.rec.name.replace(/[^\w.-]+/g, "_")}.gaze.json`, db.exportJson(this.rec, this.runs, { thumbnails }));
  }

  private async importRec(text: string) {
    try {
      const { recording, runs } = db.importJson(text);
      if (recording.id !== this.rec?.id && !(await this.lock.take(recording.id))) return this.say(`“${recording.name}” is open in another window. Close it there before importing.`);
      const existing = await db.getRecording(recording.id);
      if (existing && !confirm(`Replace the saved analysis for “${existing.name}” with the imported one?`)) return;
      if (existing) await db.deleteRecording(existing.id);
      await db.putRecording(recording);
      await db.putRuns(runs);
      this.recordings = await db.listRecordings();
      await this.selectRecording(recording.id);
      this.say(`Imported “${recording.name}”.`);
    } catch (e) { this.say(`Import failed: ${(e as Error).message}`); }
  }

  // ---------- Segments and analysis ----------

  private async addSegment() {
    if (!this.rec) return this.say("Open a video file or choose a recording first.");
    const a = parseTime(this.q<HTMLInputElement>("#seg-start").value), b = parseTime(this.q<HTMLInputElement>("#seg-end").value);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return this.say("Enter a start and end time such as 12:30 and 20:00, with the end after the start.");
    const end = this.rec.kind === "file" ? Math.min(b, this.rec.durationMs) : b;
    if (end <= a) return this.say("That segment starts after the end of the video.");
    const seg: Segment = { id: newId("seg"), start: a, end, label: this.q<HTMLInputElement>("#seg-label").value.trim(), note: "", createdAt: Date.now() };
    this.rec.segments.push(seg);
    this.rec.segments.sort((x, y) => x.start - y.start);
    await this.saveRec();
    this.q<HTMLInputElement>("#seg-label").value = "";
    this.renderSegments();
    this.drawCanvases();
    if (this.rec.kind === "file") this.analysePending();
    else this.say("Segment saved. For screen-capture recordings, play that part in the player and use Capture from screen to analyse it.");
  }

  private async deleteSegment(id: string) {
    if (!this.rec) return;
    const seg = this.rec.segments.find((s) => s.id === id);
    if (!seg || !confirm(`Remove “${seg.label || "segment"}” (${fmtTime(seg.start, 0)}–${fmtTime(seg.end, 0)})? Analysed frames not covered by another segment are deleted too.`)) return;
    this.rec.segments = this.rec.segments.filter((s) => s.id !== id);
    // Drop frames no remaining segment covers.
    const keep = normalise(this.rec.segments.map((s) => ({ start: s.start, end: s.end })));
    const remove: string[] = [], add: Run[] = [];
    for (const r of this.runs) {
      const pieces = keep.flatMap((k) => { const s = Math.max(k.start, r.start), e = Math.min(k.end, r.end); return e > s ? [{ start: s, end: e }] : []; });
      const whole = pieces.length === 1 && pieces[0].start === r.start && pieces[0].end === r.end;
      if (whole) continue;
      remove.push(r.id);
      add.push(...splitRun(r, pieces));
    }
    await db.deleteRuns(remove); await db.putRuns(add);
    this.runs = await db.getRuns(this.rec.id);
    if (this.scopeSeg === id) this.scopeSeg = null;
    await this.saveRec();
    this.recompute();
  }

  private pendingGaps(): Interval[] {
    if (!this.rec) return [];
    const want = normalise(this.rec.segments.map((s) => ({ start: s.start, end: s.end })));
    return want.flatMap((w) => subtract(w, this.coverage, this.rec!.frameIntervalMs * 1.5));
  }

  private async ensureTracker() {
    this.trackerReady ??= (async () => {
      this.setTrackerStatus("Loading face model…");
      await this.tracker.init("auto", false);
      this.setTrackerStatus(`Face model ready (${this.tracker.delegate})`);
      if (this.video.paused) setTimeout(() => this.trackCurrentFrame(), 0);
    })().catch((e) => { this.trackerReady = null; this.setTrackerStatus("Face model failed to load"); throw e; });
    return this.trackerReady;
  }

  private async analysePending() {
    if (this.busy || !this.rec) return;
    if (!this.src || !this.index) return this.say(`Open ${this.rec.fileName ?? "the video file"} first, then analyse.`);
    const gaps = this.pendingGaps();
    if (!gaps.length) return this.say("All segments are already analysed.");
    const abort = new AbortController();
    const totalFrames = gaps.reduce((s, g) => s + this.index!.frames.filter((f) => f.t >= g.start && f.t < g.end).length, 0);
    this.busy = { label: "Analysing", done: 0, total: totalFrames, abort };
    this.renderBusy();
    const started = performance.now();
    try {
      await this.ensureTracker();
      const cfg = await chooseDecoderConfig(this.index);
      const fpr = new Fingerprinter();
      let doneBefore = 0;
      const recId = this.rec.id;
      // Each piece is saved as soon as it arrives, one after another.
      let saving: Promise<void> = Promise.resolve();
      const onChunk = (run: Run) => {
        saving = saving.then(async () => {
          await db.putRuns([run]);
          this.scheduleSidecar();
          if (this.rec?.id !== recId) return;
          this.runs = await db.getRuns(recId);
          this.recompute();
        });
      };
      let stoppedAt = NaN;
      try {
        for (const gap of gaps) {
          const res = await analyseGap(this.src, this.index, cfg, gap, recId, this.tracker, fpr, (p) => {
            this.busy!.done = doneBefore + p.done;
            this.busy!.label = `Analysing ${fmtTime(p.tMs, 0)}`;
            this.renderBusy(started);
          }, onChunk, abort.signal);
          doneBefore += res.frames;
          if (res.stopped) { stoppedAt = res.reachedMs; break; }
        }
      } finally {
        await saving;
        this.scheduleSidecar(true);
      }
      const s = (performance.now() - started) / 1000;
      this.say(Number.isFinite(stoppedAt)
        ? `Stopped at ${fmtTime(stoppedAt, 0)}. The ${doneBefore.toLocaleString()} frames analysed so far are kept; press Analyse to carry on from there.`
        : `Analysed ${doneBefore.toLocaleString()} frames in ${s.toFixed(0)} s.`);
    } catch (e) {
      this.say(`Analysis failed: ${(e as Error).message}. Frames analysed before the failure are kept.`);
    } finally {
      this.busy = null;
      this.renderBusy();
      this.renderSegments();
    }
  }

  /** Rebuilds the gaze model, labels and events from the runs. */
  private recompute(fit = false) {
    if (!this.rec) return;
    this.coverage = union([], this.runs.map((r) => ({ start: r.start, end: r.end })));
    this.gaze = this.runs.length ? buildGaze(this.runs, this.rec) : null;
    if (this.gaze && this.gaze.model.validFraction > 0.2 && (!this.rec.regions.length || this.rec.regions.some((r) => r.auto))) this.autoScreen();
    this.labels = this.gaze ? classify(this.gaze, this.rec.regions) : null;
    this.events = this.gaze && this.labels ? findEvents(this.gaze, this.labels, this.rec.settings.minFrames) : [];
    this.plane.invalidateHeat();
    if (fit) this.planeFitted = false;
    if (!this.planeFitted) { this.plane.fitTo(this.gaze); this.planeFitted = !!this.gaze; }
    this.renderAll();
  }

  /** First time data arrives: a Screen region around the on-screen cluster (2nd–98th percentiles, +2°). */
  /**
   * The automatic screen region (2nd–98th percentiles of the on-screen cluster, +2°). Created
   * once there are 10 s of on-screen frames, and refitted as more is analysed until the
   * reviewer edits it, so it isn't fixed by the first few seconds of a long analysis.
   */
  private autoScreen() {
    const g = this.gaze!, rec = this.rec!;
    const hs: number[] = [], vs: number[] = [];
    for (let i = 0; i < g.n; i++) if (g.onScreen[i]) { hs.push(g.h[i]); vs.push(g.v[i]); }
    if (hs.length * rec.frameIntervalMs < 10_000) return;
    hs.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    const q = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))];
    const box = { h0: Math.round(q(hs, 0.02) - 2), h1: Math.round(q(hs, 0.98) + 2), v0: Math.round(q(vs, 0.02) - 2), v1: Math.round(q(vs, 0.98) + 2) };
    const existing = rec.regions.find((r) => r.auto);
    if (existing) {
      if (existing.h0 === box.h0 && existing.h1 === box.h1 && existing.v0 === box.v0 && existing.v1 === box.v1) return;
      Object.assign(existing, box);
    } else {
      rec.regions.push({ id: newId("reg"), name: "Laptop screen", colour: SCREEN_COLOUR, isScreen: true, auto: true, ...box });
    }
    this.saveRec();
  }

  // ---------- Regions ----------

  /** The form for naming a new region, or editing the selected one. */
  private renderRegionForm() {
    const f = this.q("#region-form");
    const editing = this.rec?.regions.find((r) => r.id === this.editRegionId) ?? null;
    if (!this.pendingRegion && !editing) { f.hidden = true; f.innerHTML = ""; return; }
    f.hidden = false;
    const n = (this.rec?.regions.filter((r) => !r.isScreen).length ?? 0) + 1;
    const otherScreen = this.rec?.regions.some((r) => r.isScreen && r.id !== editing?.id);
    const current = editing?.name ?? `Region ${n}`;
    f.innerHTML = `<span>${editing ? "Edit region" : "What is it?"}</span>
      ${REGION_PRESETS.map((p) => `<button type="button" class="chip ${p === current ? "on" : ""}" data-preset="${esc(p)}">${esc(p)}</button>`).join("")}
      <label>Name <input id="rf-name" value="${esc(current)}" maxlength="40" list="region-names"></label>
      <label class="check"><input type="checkbox" id="rf-screen" ${editing?.isScreen ? "checked" : ""}> This is the screen</label>
      <button id="rf-add" class="primary">${editing ? "Save" : "Add region"}</button>
      ${editing ? `<button id="rf-delete" class="danger">Delete region</button>` : ""}
      <button id="rf-cancel">${editing ? "Close" : "Cancel"}</button>
      ${editing ? `<span class="muted small">Drag the region on the plane to move it, or its edges and corners to resize it.</span>` : ""}`;
    const name = this.q<HTMLInputElement>("#rf-name");
    if (!editing) { name.focus(); name.select(); }
    f.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      name.value = b.dataset.preset!;
      this.q<HTMLInputElement>("#rf-screen").checked = b.dataset.preset === SCREEN_PRESET && !otherScreen;
      f.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
    }));
    const save = () => {
      if (!this.rec) return;
      const isScreen = this.q<HTMLInputElement>("#rf-screen").checked;
      if (editing) {
        editing.auto = false;
        editing.name = name.value.trim() || editing.name;
        if (isScreen !== editing.isScreen) {
          editing.isScreen = isScreen;
          editing.colour = isScreen ? SCREEN_COLOUR : this.freeColour(n);
        }
        this.editRegionId = null;
      } else if (this.pendingRegion) {
        const r = this.pendingRegion;
        this.rec.regions.push({ id: newId("reg"), name: name.value.trim() || `Region ${n}`, colour: isScreen ? SCREEN_COLOUR : this.freeColour(n), isScreen, h0: round1(r.h0), h1: round1(r.h1), v0: round1(r.v0), v1: round1(r.v1) });
        this.pendingRegion = null;
      }
      this.renderRegionForm();
      this.saveRec();
      this.recompute();
    };
    this.q("#rf-add").addEventListener("click", save);
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    this.root.querySelector("#rf-delete")?.addEventListener("click", () => editing && this.deleteRegion(editing.id));
    this.q("#rf-cancel").addEventListener("click", () => { this.pendingRegion = null; this.editRegionId = null; this.renderRegionForm(); });
  }

  private freeColour(n: number): string {
    const used = new Set(this.rec?.regions.map((r) => r.colour));
    return REGION_COLOURS.find((c) => !used.has(c)) ?? REGION_COLOURS[n % REGION_COLOURS.length];
  }

  private deleteRegion(id: string) {
    if (!this.rec) return;
    const r = this.rec.regions.find((x) => x.id === id);
    if (!r || !confirm(`Delete the region “${r.name}”?`)) return;
    this.rec.regions = this.rec.regions.filter((x) => x.id !== id);
    if (this.editRegionId === id) this.editRegionId = null;
    this.renderRegionForm();
    this.saveRec();
    this.recompute();
  }

  /** Proposes a region around where the student is looking at the playhead (±0.4 s), from the saved analysis or live tracking. */
  private labelLookingNow() {
    if (!this.rec) return;
    const ph = this.playhead(), hs: number[] = [], vs: number[] = [];
    const g = this.gaze;
    if (g) {
      for (let i = Math.max(0, indexAt(g.t, ph - 400)); i < g.n && g.t[i] <= ph + 400; i++) if (g.ok[i] && g.t[i] >= ph - 400) { hs.push(g.h[i]); vs.push(g.v[i]); }
    }
    if (hs.length < 3) for (const p of this.live.trail) if (Math.abs(p.t - ph) <= 400) { hs.push(p.h); vs.push(p.v); }
    if (!hs.length) {
      const now = this.gazeNow();
      if (now) { hs.push(now.h); vs.push(now.v); }
    }
    if (!hs.length) return this.say("There’s no gaze at this moment to label. Play or step to a frame where the face is tracked.");
    const mid = (a: number[]) => (Math.min(...a) + Math.max(...a)) / 2, half = (a: number[]) => Math.max(4, (Math.max(...a) - Math.min(...a)) / 2 + 3);
    const ch = mid(hs), cv = mid(vs), wh = half(hs), wv = half(vs);
    this.setDragMode("region");
    this.editRegionId = null;
    this.pendingRegion = { h0: ch - wh, h1: ch + wh, v0: cv - wv, v1: cv + wv };
    this.renderRegionForm();
  }

  private setDragMode(m: "highlight" | "region") {
    this.dragMode = m;
    const radio = this.root.querySelector<HTMLInputElement>(`input[name="dragmode"][value="${m}"]`);
    if (radio) radio.checked = true;
    if (m !== "region") { this.editRegionId = null; this.pendingRegion = null; this.renderRegionForm(); }
  }

  private regionEdit(e: Event) {
    const t = e.target as HTMLInputElement;
    const r = this.rec?.regions.find((x) => x.id === t.dataset.id);
    if (!r) return;
    r.auto = false;
    if (t.dataset.field === "name") r.name = t.value.trim() || r.name;
    if (t.dataset.field === "screen") { r.isScreen = t.checked; if (t.checked) r.colour = SCREEN_COLOUR; }
    if (t.dataset.field && ["h0", "h1", "v0", "v1"].includes(t.dataset.field)) {
      const v = parseFloat(t.value);
      if (Number.isFinite(v)) (r as unknown as Record<string, number>)[t.dataset.field] = v;
    }
    this.saveRec();
    this.recompute();
  }

  // ---------- Settings ----------

  private readSettings() {
    if (!this.rec) return;
    const s = this.rec.settings;
    const num = (id: string) => parseFloat(this.q<HTMLInputElement>(id).value);
    s.eyeSource = this.q<HTMLSelectElement>("#set-eye").value as "blend" | "iris";
    const autoK = this.q<HTMLInputElement>("#set-kauto").checked;
    s.kH = autoK ? null : (Number.isFinite(num("#set-kh")) ? num("#set-kh") : null);
    s.kV = autoK ? null : (Number.isFinite(num("#set-kv")) ? num("#set-kv") : null);
    s.driftWindowS = Math.max(0, num("#set-drift") || 0);
    s.minFrames = Math.max(1, Math.round(num("#set-minframes") || 1));
    s.blinkHoldMs = Math.max(0, num("#set-blink") || 0);
    s.blinkFilter = this.q<HTMLInputElement>("#set-blinkfilter").checked;
    s.blinkLidPct = Math.min(95, Math.max(20, num("#set-blinkpct") || 70));
    s.blinkMaxMs = Math.max(100, num("#set-blinkmax") || 400);
    this.saveRec();
    this.recompute();
  }

  // ---------- Capture ----------

  private async beginCapture() {
    if (this.busy) return;
    if (!navigator.mediaDevices?.getDisplayMedia) return this.say("This browser cannot capture a window or tab.");
    let rec = this.rec;
    if (rec?.kind === "capture" && !(await this.lock.take(rec.id))) return this.say(`“${rec.name}” is open in another window.`);
    if (!rec || rec.kind !== "capture") {
      const name = prompt("Name for this screen-capture recording (e.g. student ID and exam)", "");
      if (!name?.trim()) return;
      rec = {
        id: newId("cap"), name: name.trim(), kind: "capture", durationMs: 0, width: 0, height: 0, frameIntervalMs: 1000 / 30,
        segments: [], regions: [], settings: { ...DEFAULT_SETTINGS }, createdAt: Date.now(), updatedAt: Date.now(),
      };
      await this.lock.take(rec.id);
      await db.putRecording(rec);
      this.recordings = await db.listRecordings();
      this.file = null; this.src = null; this.index = null;
      this.video.removeAttribute("src"); this.video.load();
      await this.loadRec(rec);
    }
    try {
      await this.ensureTracker();
      this.capture ??= new ScreenCapture(this.tracker);
      await this.capture.choose();
      this.capture.endedByUser = () => { if (this.capturing) this.finishCapture(); else this.stopCapture(); };
      this.captureCrop = null;
      this.renderCapturePanel();
    } catch (e) {
      this.say(`Screen capture did not start: ${(e as Error).message}`);
    }
  }

  private renderCapturePanel() {
    const panel = this.q("#capture-panel");
    const on = !!this.capture?.stream;
    panel.hidden = !on;
    this.q("#video-wrap").hidden = on;
    if (!on) return;
    panel.innerHTML = `
      <p class="hint">Drag over the preview to mark the student’s video. Play it at normal speed, at least at its original size.</p>
      <div class="cap-stage"><canvas id="cap-preview"></canvas></div>
      <div class="row">
        <label>Player time now <input id="cap-start" value="${fmtTime(this.capturedPlayhead, 0)}" size="9"></label>
        <button id="cap-go" class="primary">Start analysing</button>
        <button id="cap-stop" disabled>Stop</button>
        <button id="cap-close">Close capture</button>
      </div>
      <p id="cap-status" class="status" aria-live="polite"></p>`;
    const cv = this.q<HTMLCanvasElement>("#cap-preview");
    this.captureCanvas = cv;
    let d: { x: number; y: number } | null = null;
    const toSrc = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect(), s = this.capture!.size;
      return { x: Math.round(((e.clientX - r.left) / r.width) * s.w), y: Math.round(((e.clientY - r.top) / r.height) * s.h) };
    };
    cv.addEventListener("pointerdown", (e) => { if (this.capturing) return; cv.setPointerCapture(e.pointerId); d = toSrc(e); });
    cv.addEventListener("pointermove", (e) => { if (!d) return; const p = toSrc(e); this.captureCrop = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) }; });
    cv.addEventListener("pointerup", () => { d = null; if (this.captureCrop && (this.captureCrop.w < 40 || this.captureCrop.h < 30)) this.captureCrop = null; });
    this.q("#cap-go").addEventListener("click", () => {
      const t = parseTime(this.q<HTMLInputElement>("#cap-start").value);
      if (!Number.isFinite(t)) return this.say("Type the time shown in the player, e.g. 12:30.");
      if (!this.captureCrop) return this.say("Drag over the preview to mark where the student’s video is first.");
      this.capture!.setCrop(this.captureCrop);
      this.capture!.onStatus = (s) => {
        const el = this.q("#cap-status");
        if (el) el.textContent = `Video time ≈ ${fmtTime(s.videoT, 1)} · ${s.sourceFps} new frames/s · face found in ${s.uniqueFrames ? Math.round((100 * s.faceFrames) / s.uniqueFrames) : 0}% · ${s.longGaps} pauses`;
        this.capturedPlayhead = s.videoT;
      };
      this.capture!.onFrame = (c) => { this.captureFrame = c; };
      this.capture!.start(this.rec!.id, t);
      this.capturing = true;
      this.q<HTMLButtonElement>("#cap-go").disabled = true;
      this.q<HTMLButtonElement>("#cap-stop").disabled = false;
    });
    this.q("#cap-stop").addEventListener("click", () => this.finishCapture());
    this.q("#cap-close").addEventListener("click", () => this.stopCapture());
  }

  private async finishCapture() {
    if (!this.capture || !this.rec || !this.capturing) return;
    this.capturing = false;
    const run = this.capture.finish(this.rec.frameIntervalMs);
    this.q<HTMLButtonElement>("#cap-go")?.removeAttribute("disabled");
    this.q<HTMLButtonElement>("#cap-stop")?.setAttribute("disabled", "");
    if (!run || run.t.length < 10) return this.say("Too little was captured to keep.");
    const al = alignCapture(run, this.runs, this.rec.frameIntervalMs);
    const hadOverlap = al.overlapFrames >= 30;
    let pieces: Run[];
    let approx: boolean;
    if (al.confirmed) {
      const shifted = shiftRun(run, al.shiftMs);
      shifted.approx = false;
      pieces = splitRun(shifted, subtract({ start: shifted.start, end: shifted.end }, this.coverage, this.rec.frameIntervalMs * 1.5));
      approx = false;
    } else {
      pieces = [run];
      approx = true;
    }
    const first = pieces[0]?.start ?? run.start, last = pieces[pieces.length - 1]?.end ?? run.end;
    await db.putRuns(pieces);
    const sR = al.confirmed ? run.start + al.shiftMs : run.start, eR = al.confirmed ? run.end + al.shiftMs : run.end;
    this.rec.segments.push({ id: newId("seg"), start: sR, end: eR, label: `Capture ${fmtTime(sR, 0)}`, note: "", approx, createdAt: Date.now() });
    this.rec.segments.sort((a, b) => a.start - b.start);
    this.rec.durationMs = Math.max(this.rec.durationMs, eR);
    this.rec.width = this.captureCrop?.w ?? this.rec.width; this.rec.height = this.captureCrop?.h ?? this.rec.height;
    await this.saveRec();
    this.runs = await db.getRuns(this.rec.id);
    this.recompute();
    this.say(al.confirmed
      ? `Capture kept (${fmtTime(first, 0)}–${fmtTime(last, 0)}). Timing confirmed against earlier frames (corrected by ${(al.shiftMs / 1000).toFixed(2)} s); overlapping parts were skipped.`
      : hadOverlap
        ? "Capture kept as its own segment, marked approximate: it overlaps earlier data but the frames could not be matched, so nothing was merged."
        : "Capture kept. Its times come from the start time you typed, so the segment is marked approximate until a later capture overlaps it.");
  }

  private stopCapture() {
    if (this.capturing) this.capture?.finish(this.rec?.frameIntervalMs ?? 33);
    this.capturing = false;
    this.capture?.stop();
    this.captureCanvas = null;
    this.renderCapturePanel();
  }

  // ---------- Live tracking during playback ----------

  /** Runs the face tracker on the frame just shown (not saved). */
  private onVideoFrame(t: number) {
    if (!(this.prefs.live || this.prefs.eyes) || this.busy || this.capturing || !this.rec || this.rec.kind !== "file") return;
    if (!this.tracker.ready) {
      if (!this.trackerReady) this.ensureTracker().then(() => this.trackCurrentFrame()).catch(() => {});
      return;
    }
    try {
      if (!Number.isFinite(this.lastLiveT) || t <= this.lastLiveT || t - this.lastLiveT > 500) trackerClock.begin(t);
      const res = this.tracker.detect(this.video, trackerClock.at(t));
      this.lastLiveT = t;
      this.liveLandmarks = res.raw ? { t, pts: res.raw.landmarks } : null;
      this.live.push(t, measure(res.raw), this.gaze, this.rec.settings);
    } catch (e) {
      console.warn("live tracking", e);
    }
  }

  /** For a paused video: track the frame currently shown. */
  private trackCurrentFrame() {
    if (this.video.src && this.video.readyState >= 2) this.onVideoFrame(this.video.currentTime * 1000);
  }

  private renderSound() {
    const b = this.q("#sound");
    b.textContent = this.video.muted ? "Sound off" : "Sound on";
    b.setAttribute("aria-pressed", String(!this.video.muted));
  }

  /** What the gaze is doing at the playhead: from the saved analysis if there is one, otherwise live. */
  private gazeNow(): { h: number; v: number; label: number; source: "saved" | "live" } | null {
    const ph = this.playhead(), g = this.gaze, dt = this.rec?.frameIntervalMs ?? 33;
    if (g && this.labels) {
      const i = indexAt(g.t, ph);
      if (i >= 0 && ph - g.t[i] <= 1.5 * dt) {
        return g.ok[i] ? { h: g.h[i], v: g.v[i], label: this.labels[i], source: "saved" } : null;
      }
    }
    const p = this.live.last;
    const tol = this.video.paused ? 1.5 * dt + 50 : 500; // live tracking may trail the playhead while playing
    if (this.prefs.live && p && Math.abs(p.t - ph) <= tol) return { h: p.h, v: p.v, label: labelPoint(p.h, p.v, this.rec?.regions ?? [], g), source: "live" };
    return null;
  }

  private renderReadout() {
    const box = this.q("#readout");
    if (!this.rec || this.rec.kind !== "file" || !this.video.src) { box.hidden = true; return; }
    box.hidden = false;
    const now = this.gazeNow();
    const ph = this.playhead(), dt = this.rec.frameIntervalMs;
    let html: string;
    if (!now) {
      const analysedHere = !!this.gaze && (() => { const i = indexAt(this.gaze!.t, ph); return i >= 0 && ph - this.gaze!.t[i] <= 1.5 * dt; })();
      const triedHere = Number.isFinite(this.lastLiveT) && Math.abs(this.lastLiveT - ph) <= 1.5 * dt + 50;
      const why = analysedHere ? "No gaze in this frame: no face found, or the eyes were closed." :
        !this.prefs.live ? "This moment isn’t analysed. Turn on live tracking, or add a segment." :
        !this.tracker.ready ? "Loading the face model…" :
        triedHere ? "No gaze in this frame: no face found, or the eyes were closed." :
        !this.video.paused ? "Live tracking can’t keep up at this speed. Try ½× or pause." :
        "Tracking this frame…";
      html = `<div class="where muted">–</div><div class="src">${why}</div>`;
    } else {
      const regions = this.rec.regions;
      const r = now.label >= 0 ? regions[now.label] : null;
      const known = !!this.gaze || regions.length > 0;
      const name = r ? esc(r.name) : !known ? "Gaze position" : now.label === SCREEN ? "Screen" : "Elsewhere";
      const colour = r ? r.colour : !known ? "var(--live)" : now.label === SCREEN ? "var(--screen)" : "var(--elsewhere)";
      const m = this.gaze?.model;
      const refH = m?.screenH ?? 0, refV = m?.screenV ?? 0;
      const dh = now.h - refH, dv = now.v - refV;
      const dir = `${Math.abs(dh).toFixed(0)}° to their ${dh >= 0 ? "left" : "right"}, ${Math.abs(dv).toFixed(0)}° ${dv >= 0 ? "up" : "down"}`;
      const ref = m ? "from the screen centre" : "from the camera";
      const src = now.source === "saved" ? "From the saved analysis." :
        m ? "Tracked live, not saved." : "Tracked live, not saved. Positions are approximate until a segment is analysed.";
      html = `<div class="where"><span class="swatch" style="background:${colour}"></span>${name}</div>
        <div class="detail">${dir} ${ref}</div><div class="src ${now.source === "live" ? "live" : ""}">${src}</div>`;
    }
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  /** Eye corners, lids and irises from the live tracker, drawn over the video. */
  private drawEyeOverlay() {
    const cv = this.q<HTMLCanvasElement>("#eye-overlay");
    const ctx = cv.getContext("2d")!;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const L = this.liveLandmarks, vw = this.video.videoWidth, vh = this.video.videoHeight;
    const tol = this.video.paused ? 1.5 * (this.rec?.frameIntervalMs ?? 33) + 50 : 500;
    if (!this.prefs.eyes || !L || !vw || Math.abs(L.t - this.playhead()) > tol) return;
    const s = Math.min(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
    const P = (i: number) => ({ x: ox + L.pts[i].x * vw * s, y: oy + L.pts[i].y * vh * s });
    ctx.lineWidth = 1.5;
    for (const eye of [
      { corners: [LM.rEyeOuter, LM.rEyeInner], lids: [LM.rEyeUpper, LM.rEyeLower], iris: LM.rIrisCentre, ring: [469, 471] },
      { corners: [LM.lEyeInner, LM.lEyeOuter], lids: [LM.lEyeUpper, LM.lEyeLower], iris: LM.lIrisCentre, ring: [474, 476] },
    ]) {
      const [a, b] = eye.corners.map(P), [u, d] = eye.lids.map(P);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(2 * u.x - (a.x + b.x) / 2, 2 * u.y - (a.y + b.y) / 2, b.x, b.y);
      ctx.quadraticCurveTo(2 * d.x - (a.x + b.x) / 2, 2 * d.y - (a.y + b.y) / 2, a.x, a.y); ctx.stroke();
      if (L.pts.length > eye.ring[1]) {
        const c = P(eye.iris), r1 = P(eye.ring[0]), r2 = P(eye.ring[1]);
        const rad = Math.max(2, Math.hypot(r1.x - r2.x, r1.y - r2.y) / 2);
        ctx.strokeStyle = "#f5a524"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, rad, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#f5a524"; ctx.beginPath(); ctx.arc(c.x, c.y, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = 1.5;
      }
    }
  }

  // ---------- Playback and scope ----------

  private playhead(): number {
    if (this.capture?.stream || this.rec?.kind === "capture" || !this.video.src) return this.capturedPlayhead;
    return this.video.currentTime * 1000;
  }

  private seek(t: number) {
    if (this.rec?.kind === "capture" || !this.video.src) {
      this.capturedPlayhead = t;
      this.q("#time").textContent = fmtTime(t);
      if (this.rec?.kind === "capture") this.say(`Go to ${fmtTime(t, 1)} in the exam player to see this moment.`);
      return;
    }
    this.video.currentTime = t / 1000;
  }

  private togglePlay() {
    if (!this.video.src) return;
    if (this.video.paused) this.video.play(); else this.video.pause();
  }

  private stepFrames(n: number) {
    if (!this.video.src || !this.rec) return;
    this.video.pause();
    this.video.currentTime = Math.max(0, this.video.currentTime + (n * this.rec.frameIntervalMs) / 1000);
  }

  private setScope(id: string | null) {
    this.scopeSeg = id;
    this.win = this.scopeWindow();
    this.plane.invalidateHeat();
    const seg = this.rec?.segments.find((s) => s.id === id);
    if (seg) this.seek(seg.start);
    this.renderSegments();
    this.renderEvents();
    this.renderRegions();
  }

  private scope(): Interval | null {
    const s = this.rec?.segments.find((x) => x.id === this.scopeSeg);
    return s ? { start: s.start, end: s.end } : null;
  }

  private scopeWindow(): Interval {
    const s = this.scope();
    if (s) return s;
    if (this.coverage.length) return { start: this.coverage[0].start, end: Math.min(this.coverage[0].start + 120000, this.coverage[this.coverage.length - 1].end) };
    return { start: 0, end: Math.min(120000, this.rec?.durationMs || 120000) };
  }

  private clampWin(w: Interval): Interval {
    const span = Math.max(300, w.end - w.start);
    const dur = Math.max(this.rec?.durationMs ?? 0, this.coverage[this.coverage.length - 1]?.end ?? 0, 1000);
    let s = Math.max(0, w.start);
    if (s + span > dur) s = Math.max(0, dur - span);
    return { start: s, end: s + span };
  }

  private zoom(f: number) {
    const c = this.playhead(), span = (this.win.end - this.win.start) * f;
    this.win = this.clampWin({ start: c - span / 2, end: c + span / 2 });
  }

  private selectEvent(i: number) {
    if (i < 0 || i >= this.events.length) return;
    this.selectedEvent = i;
    const ev = this.events[i];
    this.video.pause();
    this.seek(Math.max(0, ev.start - 300));
    const span = this.win.end - this.win.start;
    if (ev.start < this.win.start || ev.end > this.win.end) this.win = this.clampWin({ start: ev.start - span / 2, end: ev.start + span / 2 });
    this.renderEvents();
    this.root.querySelector(`#events tr[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private nextEvent(dir: 1 | -1): number {
    const vis = this.visibleEvents().map((x) => x.i);
    if (!vis.length) return -1;
    const pos = vis.indexOf(this.selectedEvent);
    if (pos < 0) {
      const t = this.playhead();
      return dir > 0 ? vis.find((i) => this.events[i].start > t) ?? vis[vis.length - 1] : [...vis].reverse().find((i) => this.events[i].start < t) ?? vis[0];
    }
    return vis[Math.max(0, Math.min(vis.length - 1, pos + dir))];
  }

  private visibleEvents(): { e: GazeEvent; i: number }[] {
    const sc = this.scope();
    return this.events.map((e, i) => ({ e, i })).filter(({ e }) =>
      (!sc || (e.start >= sc.start && e.start < sc.end)) &&
      (this.eventFilter === "all" || String(e.region) === this.eventFilter));
  }

  // ---------- Rendering ----------

  private frame() {
    const playing = !this.video.paused;
    const ph = this.playhead();
    if (playing && (ph > this.win.end || ph < this.win.start)) {
      const span = this.win.end - this.win.start;
      this.win = this.clampWin({ start: ph - span * 0.1, end: ph + span * 0.9 });
    }
    this.q("#time").textContent = fmtTime(ph);
    this.q("#play").textContent = playing ? "Pause" : "Play";
    if (!playing && (this.prefs.live || this.prefs.eyes) && this.tracker.ready && !this.busy && this.video.readyState >= 2 &&
        this.lastAttemptPh !== ph) {
      this.lastAttemptPh = ph;
      if (!(Math.abs(this.lastLiveT - ph) <= 1)) this.trackCurrentFrame();
    }
    this.drawCanvases();
  }

  private drawCanvases() {
    if (!this.plane) return;
    const ph = this.playhead();
    const live = this.capturing ? this.captureFrame : null;
    const inset: CanvasImageSource | null = live ?? (this.video.src && this.video.readyState >= 2 ? this.video : null);
    const insetAspect = inset === this.video ? (this.video.videoWidth / this.video.videoHeight || 4 / 3) :
      this.captureCrop ? this.captureCrop.w / this.captureCrop.h : 4 / 3;
    this.plane.draw({
      gaze: this.gaze, scope: this.scope(), regions: this.rec?.regions ?? [], playhead: ph,
      // With the heatmap showing the highlighted stretch, its points aren't drawn on top as well.
      timeBrush: this.q<HTMLSelectElement>("#heat-scope").value === "brush" ? null : this.timeBrush, planeBrush: this.planeBrush, draft: this.planeDraft,
      inset, insetAspect,
      ...this.heatState(), trailMs: 2000,
      editable: this.dragMode === "region", selectedRegion: this.editRegionId,
      live: this.prefs.live && this.gazeNow()?.source !== "saved" && this.rec?.kind === "file"
        ? { trail: this.live.trail, point: this.gazeNow()?.source === "live" ? (this.live.last as LivePoint) : null } : null,
    });
    this.drawEyeOverlay();
    this.renderReadout();
    this.overview.draw(Math.max(this.rec?.durationMs ?? 0, this.coverage[this.coverage.length - 1]?.end ?? 0, 60000),
      this.rec?.segments ?? [], this.coverage, ph, this.win, this.scopeSeg);
    this.detail.draw({
      gaze: this.gaze, labels: this.labels, events: this.events, regions: this.rec?.regions ?? [], win: this.win,
      playhead: ph, timeBrush: this.timeBrush, planeBrush: this.planeBrush, selectedEvent: this.selectedEvent,
    }, this.timeDraft);
    if (this.captureCanvas && this.capture?.stream) this.drawCapturePreview();
  }

  /** Which frames the heatmap counts: the segment (or all), the highlighted stretch only, or none. */
  private heatState(): { showHeat: boolean; heatScope: Interval | null; heatHint: string } {
    const mode = this.q<HTMLSelectElement>("#heat-scope").value;
    if (mode === "off") return { showHeat: false, heatScope: null, heatHint: "" };
    if (mode === "brush") {
      return this.timeBrush
        ? { showHeat: true, heatScope: this.timeBrush, heatHint: `Heatmap: ${fmtTime(this.timeBrush.start)}–${fmtTime(this.timeBrush.end)}` }
        : { showHeat: false, heatScope: null, heatHint: "Drag across the timeline to choose the stretch for the heatmap" };
    }
    return { showHeat: true, heatScope: this.scope(), heatHint: "" };
  }

  private renderHeatScope() {
    this.plane.invalidateHeat();
    const opt = this.root.querySelector<HTMLOptionElement>('#heat-scope option[value="brush"]');
    if (opt) opt.textContent = this.timeBrush ? `highlighted stretch (${fmtTime(this.timeBrush.start, 0)}–${fmtTime(this.timeBrush.end, 0)})` : "highlighted stretch";
  }

  private drawCapturePreview() {
    const cv = this.captureCanvas!, v = this.capture!.video;
    if (!v.videoWidth) return;
    const maxW = cv.parentElement!.clientWidth;
    const w = Math.min(maxW, v.videoWidth), h = (w * v.videoHeight) / v.videoWidth;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(v, 0, 0);
    if (this.captureCrop) {
      const c = this.captureCrop;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, cv.width, c.y); ctx.fillRect(0, c.y + c.h, cv.width, cv.height - c.y - c.h);
      ctx.fillRect(0, c.y, c.x, c.h); ctx.fillRect(c.x + c.w, c.y, cv.width - c.x - c.w, c.h);
      ctx.strokeStyle = "#E0A400"; ctx.lineWidth = Math.max(2, cv.width / 400); ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.fillStyle = "#E0A400"; ctx.font = `${Math.max(12, cv.width / 80)}px system-ui`;
      ctx.fillText(`${c.w}×${c.h}`, c.x + 6, c.y + Math.max(16, cv.width / 60));
    }
  }

  private renderAll() {
    const has = !!this.rec;
    this.q("#rec-title").textContent = this.rec ? this.rec.name : "No recording open";
    for (const id of ["#export", "#rename", "#delete-rec"]) this.q<HTMLButtonElement>(id).disabled = !has;
    this.q("#empty").hidden = has;
    this.q("#workspace").hidden = !has;
    this.q("#video-placeholder").hidden = !!this.video.src || this.rec?.kind === "capture";
    this.q("#capture-note").hidden = this.rec?.kind !== "capture";
    this.q("#video-controls").hidden = this.rec?.kind === "capture";
    if (this.rec?.kind === "file" && !this.file) this.q("#video-placeholder").textContent = `Open ${this.rec.fileName ?? "the video file"} to play it here.`;
    this.renderSegments();
    this.renderEvents();
    this.renderRegions();
    this.renderSettings();
    this.renderBusy();
    this.drawCanvases();
  }

  private renderSegments() {
    const box = this.q("#segments");
    if (!this.rec) { box.innerHTML = ""; return; }
    const pendingTotal = totalLength(this.pendingGaps());
    box.innerHTML = this.rec.segments.length ? this.rec.segments.map((s) => {
      const len = s.end - s.start;
      const cov = len - totalLength(subtract({ start: s.start, end: s.end }, this.coverage));
      const pct = Math.round((100 * cov) / len);
      const status = pct >= 99 ? "analysed" : pct > 0 ? `${pct}% analysed` : "not analysed";
      return `<li class="${s.id === this.scopeSeg ? "selected" : ""}">
        <div class="seg-main"><strong>${esc(s.label || "Segment")}</strong>
          <span class="num">${fmtTime(s.start, 0)}–${fmtTime(s.end, 0)}</span>
          <span class="muted">${status}${s.approx ? ", times approximate" : ""}</span></div>
        <div class="seg-actions">
          <button data-act="scope" data-id="${s.id}">${s.id === this.scopeSeg ? "Show all" : "Show"}</button>
          ${pct < 99 && this.rec!.kind === "file" ? `<button data-act="analyse" data-id="${s.id}">Analyse</button>` : ""}
          <button data-act="delete" data-id="${s.id}" aria-label="Remove segment">Remove</button>
        </div></li>`;
    }).join("") : `<li class="muted">No segments yet. Add the part of the exam you want to look at.</li>`;
    this.q("#coverage-summary").textContent = this.coverage.length
      ? `${fmtTime(totalLength(this.coverage), 0)} analysed${pendingTotal > 0 ? `, ${fmtTime(pendingTotal, 0)} waiting` : ""}` : "";
    this.q<HTMLButtonElement>("#scope-all").disabled = !this.scopeSeg;
  }

  private renderEvents() {
    const filter = this.q<HTMLSelectElement>("#event-filter");
    const regions = this.rec?.regions ?? [];
    const opts = [`<option value="all">Everywhere off screen</option>`,
      ...regions.map((r, i) => r.isScreen ? "" : `<option value="${i}">${esc(r.name)}</option>`),
      `<option value="${ELSEWHERE}">Unlabelled</option>`].join("");
    if (filter.dataset.opts !== opts) { filter.innerHTML = opts; filter.dataset.opts = opts; filter.value = this.eventFilter; }
    if (filter.value !== this.eventFilter) this.eventFilter = filter.value || "all";
    const vis = this.visibleEvents();
    this.q("#event-count").textContent = `${vis.length} ${vis.length === 1 ? "glance" : "glances"}`;
    const dt = this.rec?.frameIntervalMs ?? 33;
    this.q("#events").innerHTML = vis.length ? `<table><thead><tr><th>Start</th><th>Length</th><th>Where</th><th>Furthest</th><th>Lids</th></tr></thead><tbody>` +
      vis.map(({ e, i }) => {
        const r = e.region >= 0 ? regions[e.region] : null;
        return `<tr data-i="${i}" class="${i === this.selectedEvent ? "selected" : ""}" tabindex="0">
          <td class="num">${fmtTime(e.start, 1)}</td>
          <td class="num">${Math.round(e.frames * dt)} ms <span class="muted">(${e.frames} fr)</span></td>
          <td>${r ? `<span class="swatch" style="background:${r.colour}"></span>${esc(r.name)}` : "<span class=\"muted\">unlabelled</span>"}</td>
          <td class="num">${e.peakDist.toFixed(0)}°</td>
          <td>${Number.isFinite(e.lidMin) && e.lidMin < 0.6 ? "<span title=\"Lids narrowed to under 60% of usual: may be a blink or a look down\">narrowed</span>" : ""}</td></tr>`;
      }).join("") + `</tbody></table>` : `<p class="muted">${this.gaze ? "No glances away from the screen in this view." : "Glances appear here once a segment is analysed."}</p>`;
  }

  private renderLegend() {
    const regions = this.rec?.regions ?? [];
    const sw = (c: string, label: string) => `<span class="swatch" style="background:${c}"></span>${esc(label)}`;
    const named = regions.filter((r) => !r.isScreen).map((r) => sw(r.colour, r.name));
    const screen = regions.find((r) => r.isScreen);
    const html = [sw("var(--screen)", screen?.name ?? "screen"), ...named, sw("var(--elsewhere)", "elsewhere"), sw("var(--nodata)", "no gaze"),
      `<span class="swatch blink-key"></span>blink removed`].join(" ");
    const el = this.q("#legend");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  private renderRegions() {
    this.renderLegend();
    const box = this.q("#regions");
    if (!this.rec || !this.gaze || !this.labels) { box.innerHTML = `<p class="muted">Regions appear once a segment is analysed.</p>`; return; }
    const sc = this.scope() ?? { start: -Infinity, end: Infinity };
    const d = dwell(this.gaze, this.labels, sc.start, sc.end);
    const total = [...d.entries()].filter(([k]) => k !== NONE).reduce((s, [, v]) => s + v, 0) || 1;
    const pct = (k: number) => `${Math.round((100 * (d.get(k) ?? 0)) / total)}%`;
    box.innerHTML = `<table><thead><tr><th></th><th>Name</th><th>Screen</th><th>Time</th><th class="coords">Extent (°)</th><th></th></tr></thead><tbody>` +
      this.rec.regions.map((r, i) => `<tr>
        <td><span class="swatch" style="background:${r.colour}"></span></td>
        <td><input data-id="${r.id}" data-field="name" value="${esc(r.name)}" size="12" list="region-names" aria-label="Region name"></td>
        <td><input type="checkbox" data-id="${r.id}" data-field="screen" ${r.isScreen ? "checked" : ""} aria-label="This region is the screen"></td>
        <td class="num">${r.isScreen ? pct(SCREEN) : pct(i)}</td>
        <td class="coords">${coordInputs(r)}</td>
        <td><button data-act="delete" data-id="${r.id}">Remove</button></td></tr>`).join("") +
      `<tr><td><span class="swatch" style="background:var(--elsewhere)"></span></td><td colspan="2" class="muted">Elsewhere</td><td class="num">${pct(ELSEWHERE)}</td><td></td><td></td></tr>` +
      `</tbody></table>`;
  }

  private renderSettings() {
    if (!this.rec) return;
    const s = this.rec.settings, m = this.gaze?.model;
    this.q<HTMLSelectElement>("#set-eye").value = s.eyeSource;
    this.q<HTMLInputElement>("#set-kauto").checked = s.kH === null && s.kV === null;
    this.q<HTMLInputElement>("#set-kh").value = String(round1(s.kH ?? m?.kH ?? NaN) || "");
    this.q<HTMLInputElement>("#set-kv").value = String(round1(s.kV ?? m?.kV ?? NaN) || "");
    this.q<HTMLInputElement>("#set-drift").value = String(s.driftWindowS);
    this.q<HTMLInputElement>("#set-minframes").value = String(s.minFrames);
    this.q<HTMLInputElement>("#set-blink").value = String(s.blinkHoldMs);
    this.q<HTMLInputElement>("#set-blinkfilter").checked = s.blinkFilter;
    this.q<HTMLInputElement>("#set-blinkpct").value = String(s.blinkLidPct);
    this.q<HTMLInputElement>("#set-blinkmax").value = String(s.blinkMaxMs);
    this.q("#model-info").innerHTML = m ? `
      <dt>Eye scale, horizontal</dt><dd>${m.kH.toFixed(0)}°/unit, ${m.kHSource}${Number.isFinite(m.rH) ? `; r = ${Math.abs(m.rH).toFixed(2)}` : ""}</dd>
      <dt>Eye scale, vertical</dt><dd>${m.kV.toFixed(0)}°/unit, ${m.kVSource}${Number.isFinite(m.rV) ? `; r = ${Math.abs(m.rV).toFixed(2)}` : ""}</dd>
      <dt>Blinks removed</dt><dd>${this.rec.settings.blinkFilter ? m.blinksRemoved.toLocaleString() : "off"}</dd>
      <dt>Head direction signs</dt><dd>${m.headSignNote}</dd>
      <dt>Screen centre</dt><dd>${m.screenH.toFixed(0)}° horizontal, ${m.screenV.toFixed(0)}° vertical from the camera</dd>
      <dt>Gaze available</dt><dd>${Math.round(m.validFraction * 100)}% of analysed frames; ${Math.round(m.screenFraction * 100)}% of those near the screen centre</dd>` : "<dt>Model</dt><dd>Not fitted yet.</dd>";
  }

  private renderBusy(started?: number) {
    const b = this.busy, box = this.q("#busy");
    box.hidden = !b;
    if (!b) return;
    const frac = b.total ? b.done / b.total : 0;
    let eta = "";
    if (started && frac > 0.02) {
      const el = (performance.now() - started) / 1000;
      eta = `, about ${fmtTime(((el / frac) - el) * 1000, 0)} left`;
    }
    this.q("#busy-label").textContent = `${b.label}: ${b.done.toLocaleString()} of ${b.total.toLocaleString()} frames${eta}`;
    this.q<HTMLProgressElement>("#busy-bar").value = frac;
  }

  private setTrackerStatus(s: string) { this.q("#tracker-status").textContent = s; }

  private say(s: string) {
    this.message = s;
    this.q("#message").textContent = this.message;
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Stops the same recording being open in two windows (each would analyse the same parts
 * and overwrite the other's regions). Uses the Web Locks API, shared by all windows of
 * this site; browsers without it are not guarded.
 */
class RecordingLock {
  private held: string | null = null;
  private release: (() => void) | null = null;
  async take(id: string): Promise<boolean> {
    if (this.held === id) return true;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) return true;
    const got = await new Promise<boolean>((resolve) => {
      locks.request(`gaze-review:${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise<void>((r) => { this.pendingRelease = r; });
      });
    });
    if (!got) return false;
    this.release?.();
    this.release = this.pendingRelease;
    this.held = id;
    return true;
  }
  private pendingRelease: (() => void) | null = null;
}

interface Prefs { muted: boolean; volume: number; live: boolean; eyes: boolean }
function loadPrefs(): Prefs {
  const d: Prefs = { muted: false, volume: 1, live: true, eyes: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem("gaze-review-prefs") ?? "{}") }; } catch { return d; }
}
function savePrefs(p: Prefs) { try { localStorage.setItem("gaze-review-prefs", JSON.stringify(p)); } catch { /* private mode */ } }

const SCREEN_PRESET = "Laptop screen";
const REGION_PRESETS = [SCREEN_PRESET, "Phone", "Paper", "Second screen", "Keyboard", "Another person", "Thinking (no object)"];

function coordInputs(r: Region): string {
  const inp = (k: "h0" | "h1" | "v0" | "v1", label: string) =>
    `<input data-id="${r.id}" data-field="${k}" value="${r[k]}" size="3" inputmode="decimal" aria-label="${label}">`;
  return `<span class="coord">across ${inp("h0", "Left edge, degrees")} to ${inp("h1", "Right edge, degrees")}</span>` +
    `<span class="coord">up ${inp("v0", "Bottom edge, degrees")} to ${inp("v1", "Top edge, degrees")}</span>`;
}

const TEMPLATE = `
<header class="bar">
  <h1>Gaze review</h1>
  <div class="bar-controls">
    <select id="rec-select" aria-label="Saved recordings"></select>
    <button id="open-file" class="primary">Open video file…</button>
    <input id="file-input" type="file" accept="video/webm,.webm,.mkv" hidden>
    <button id="start-capture">Capture from screen…</button>
    <span class="sep"></span>
    <button id="rename">Rename</button>
    <button id="export" aria-haspopup="true">Export…</button>
    <button id="import">Import</button>
    <input id="import-input" type="file" accept=".json,application/json" hidden>
    <button id="delete-rec" class="danger">Delete</button>
  </div>
  <span id="folder" class="folder" hidden>
    <button id="folder-btn">Save to a folder…</button>
    <select id="folder-videos" aria-label="Videos in the linked folder" hidden></select>
    <span id="folder-status" class="muted small"></span>
  </span>
  <span id="tracker-status" class="muted"></span>
</header>
<div id="export-menu" class="export-menu" hidden>
  <label class="check"><input type="checkbox" id="export-thumbs" checked> Include frame thumbnails</label>
  <span class="muted small">16×12-pixel greyscale thumbnails of every analysed frame. They’re only needed to line up later screen captures with this analysis; leave them out for a smaller file with no image-derived data.</span>
  <button id="export-go" class="primary">Download</button> <button id="export-cancel">Cancel</button>
</div>
<p id="message" class="message" aria-live="polite"></p>
<div id="busy" class="busy" hidden><span id="busy-label"></span><progress id="busy-bar" max="1" value="0"></progress><button id="stop-busy">Stop</button></div>

<section id="empty" class="empty">
  <h2>Open an exam recording to start</h2>
  <p>Open a WebM video file, or capture the video from a player window if you can’t download it. Nothing leaves this computer: analysis runs in the browser and only measurements are saved, never video.</p>
  <p>Then add the segments you want to look at. Each segment is analysed once; overlapping segments reuse what’s already done.</p>
</section>

<datalist id="region-names">${["Laptop screen", "Phone", "Paper", "Second screen", "Keyboard", "Another person", "Thinking (no object)"].map((p) => `<option value="${p}">`).join("")}</datalist>
<main id="workspace" hidden>
  <h2 id="rec-title" class="rec-title"></h2>
  <div class="stage">
    <section class="video-col">
      <div id="video-wrap">
        <div class="video-box"><video id="video" playsinline></video><canvas id="eye-overlay" aria-hidden="true"></canvas><p id="video-placeholder" class="placeholder"></p>
          <p id="capture-note" class="placeholder" hidden>Screen-capture recording: no video is kept. Clicking a time shows where to go in the exam player.</p></div>
        <div id="video-controls" class="row transport">
          <button id="back-frame" aria-label="Back one frame">◀ frame</button>
          <button id="play" class="primary">Play</button>
          <button id="fwd-frame" aria-label="Forward one frame">frame ▶</button>
          <select id="rate" aria-label="Playback speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
          <button id="sound" aria-pressed="true">Sound on</button>
          <input id="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" id="live-on"> Track gaze live during playback</label>
          <label class="check"><input type="checkbox" id="show-eyes"> Show tracked eyes on the video</label>
        </div>
        <div id="readout" class="readout" aria-live="off" hidden></div>
        <div class="row"><button id="label-now">Label where they’re looking now</button><span class="muted small">or press L</span></div>
      </div>
      <div id="capture-panel" class="capture" hidden></div>
      <p class="time-row"><span id="time" class="num big"></span></p>
      <p class="keys muted">Space play/pause · ← → one frame (Shift: ten) · N / P next or previous glance · L label where they’re looking · Esc clear highlights</p>
    </section>
    <section class="plane-col">
      <canvas id="plane" aria-label="Where the student is looking, seen from the camera"></canvas>
      <div class="row plane-tools">
        <span>On the plane:</span>
        <label class="check"><input type="radio" name="dragmode" value="highlight" checked> drag to highlight those times</label>
        <label class="check"><input type="radio" name="dragmode" value="region"> label and edit regions</label>
        <label>Heatmap of <select id="heat-scope"><option value="scope">the segment shown</option><option value="brush">highlighted stretch</option><option value="off">nothing (off)</option></select></label>
        <button id="fit-plane">Fit view</button>
        <button id="clear-hl">Clear highlights</button>
      </div>
      <p class="muted small plane-help">In label and edit mode: click a hotspot or drag a box to add a region; click a region to rename or delete it; drag it, or its edges and corners, to move or resize it.</p>
      <div id="region-form" class="row region-form" hidden></div>
    </section>
  </div>

  <section class="timeline">
    <canvas id="overview" aria-label="Whole recording: segments and analysed parts"></canvas>
    <canvas id="detail" aria-label="Horizontal and vertical gaze over time"></canvas>
    <div class="row">
      <button id="zoom-in">Zoom in</button><button id="zoom-out">Zoom out</button><button id="zoom-scope">Fit segment</button>
      <span class="muted">Click to go to a moment, drag to highlight a stretch, scroll to zoom.</span>
      <span id="legend" class="legend"></span>
    </div>
  </section>

  <div class="panels">
    <section class="panel">
      <h3>Segments <span id="coverage-summary" class="muted small"></span></h3>
      <ul id="segments" class="segments"></ul>
      <div class="seg-form">
        <label>From <input id="seg-start" size="8" placeholder="12:00"></label><button id="seg-start-now" title="Use the current time">Now</button>
        <label>to <input id="seg-end" size="8" placeholder="20:00"></label><button id="seg-end-now" title="Use the current time">Now</button>
        <label>Label <input id="seg-label" size="12" placeholder="optional"></label>
        <button id="seg-add" class="primary">Add segment</button>
        <button id="scope-all">Show all segments</button>
      </div>
    </section>
    <section class="panel">
      <h3>Glances away <span id="event-count" class="muted small"></span></h3>
      <label class="small">Show <select id="event-filter"></select></label>
      <div id="events" class="events"></div>
    </section>
    <section class="panel">
      <h3>Regions</h3>
      <div id="regions" class="regions"></div>
      <h3>Gaze model</h3>
      <div id="settings" class="settings">
        <label>Eye measure <select id="set-eye"><option value="blend">Face model’s gaze estimate</option><option value="iris">Iris position</option></select></label>
        <label class="check"><input type="checkbox" id="set-kauto"> Fit eye scale automatically</label>
        <label>Eye scale, horizontal <input id="set-kh" size="5" inputmode="decimal"> °/unit</label>
        <label>Eye scale, vertical <input id="set-kv" size="5" inputmode="decimal"> °/unit</label>
        <label>Follow posture drift over <input id="set-drift" size="4" inputmode="numeric"> s (0 = off)</label>
        <label>Shortest glance listed <input id="set-minframes" size="3" inputmode="numeric"> frames</label>
        <label class="check"><input type="checkbox" id="set-blinkfilter"> Remove blinks from the eye trace</label>
        <label>A blink is the lids below <input id="set-blinkpct" size="3" inputmode="numeric"> % of usual for at most <input id="set-blinkmax" size="4" inputmode="numeric"> ms</label>
        <label>Hold the last eye position when the eyes can’t be measured, up to <input id="set-blink" size="4" inputmode="numeric"> ms</label>
      </div>
      <dl id="model-info" class="model-info"></dl>
    </section>
  </div>
</main>
`;
