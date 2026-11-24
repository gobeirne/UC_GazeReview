import type { LinkedVideo } from "../store/types";
import { fmtTime } from "./util";

/**
 * A second video (for example a screen recording) shown in its own window and kept in step
 * with the main video: its time = main time − offset. Playback, pausing, seeking and speed
 * follow the main video; the offset can be adjusted in that window. The window is created
 * from this page, so nothing is loaded from anywhere else.
 */
export class LinkedVideoWindow {
  private win: Window | null = null;
  private video: HTMLVideoElement | null = null;
  private status: HTMLElement | null = null;
  private offsetLabel: HTMLElement | null = null;
  private url = "";
  link: LinkedVideo | null = null;
  onOffsetChange?: (offsetMs: number) => void;

  get open(): boolean { return !!this.win && !this.win.closed; }

  /** Opens an empty window now (from a click), so a file loaded after waiting isn't blocked as a pop-up. */
  prepare(): boolean {
    if (this.open) return true;
    this.win = window.open("", "gaze-review-linked", "width=960,height=640");
    if (!this.win) return false;
    this.build();
    return true;
  }

  /** Opens (or reuses) the window with this file. Returns false if the browser blocked the window. */
  show(file: File, link: LinkedVideo): boolean {
    this.link = link;
    if (!this.open) {
      this.win = window.open("", "gaze-review-linked", "width=960,height=640");
      if (!this.win) return false;
      this.build();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.video!.src = this.url;
    this.win!.document.title = `${file.name} (synchronised)`;
    this.updateOffset();
    this.win!.focus();
    return true;
  }

  close() {
    if (this.open) this.win!.close();
    this.win = null; this.video = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = ""; }
  }

  private build() {
    const d = this.win!.document;
    d.open();
    d.write(`<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Synchronised video</title>
<style>
  body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#12171c;color:#e4e9ed;display:flex;flex-direction:column;height:100vh}
  video{flex:1;min-height:0;width:100%;background:#000;object-fit:contain}
  .bar{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 10px;background:#1a2128}
  button{font:inherit;color:inherit;background:#202931;border:1px solid #2f3a44;border-radius:6px;padding:4px 9px;cursor:pointer}
  .muted{color:#9aa7b2;font-size:12px}
  .status{margin-left:auto}
  .cover{position:absolute;inset:0 0 48px 0;display:grid;place-items:center;color:#c9d1d8;background:rgba(0,0,0,.6);pointer-events:none}
  [hidden]{display:none !important}
</style></head><body>
<video playsinline muted></video>
<div class="cover" hidden></div>
<div class="bar">
  <span>Starts <strong class="off"></strong> after the main video</span>
  <button data-ms="-1000">−1 s</button><button data-ms="-100">−0.1 s</button><button data-ms="100">+0.1 s</button><button data-ms="1000">+1 s</button>
  <label><input type="checkbox" class="sound"> Sound</label>
  <span class="status muted"></span>
</div></body></html>`);
    d.close();
    this.video = d.querySelector("video");
    this.status = d.querySelector(".status");
    this.offsetLabel = d.querySelector(".off");
    d.querySelectorAll<HTMLButtonElement>("button[data-ms]").forEach((b) => b.addEventListener("click", () => {
      if (!this.link) return;
      this.link.offsetMs += Number(b.dataset.ms);
      this.link.offsetSource = "adjusted by hand";
      this.updateOffset();
      this.onOffsetChange?.(this.link.offsetMs);
    }));
    d.querySelector<HTMLInputElement>(".sound")!.addEventListener("change", (e) => { this.video!.muted = !(e.target as HTMLInputElement).checked; });
  }

  private updateOffset() {
    if (!this.offsetLabel || !this.link) return;
    const s = this.link.offsetMs / 1000;
    this.offsetLabel.textContent = `${s >= 0 ? "" : "−"}${Math.abs(s).toFixed(1)} s`;
    if (this.status) this.status.textContent = `offset ${this.link.offsetSource}`;
  }

  /** Called every animation frame with the main video's state. */
  follow(mainTime: number, playing: boolean, rate: number) {
    if (!this.open || !this.video || !this.link) { if (this.win && this.win.closed) this.win = null; return; }
    const v = this.video;
    const target = mainTime - this.link.offsetMs / 1000;
    const cover = this.win!.document.querySelector<HTMLElement>(".cover")!;
    const outside = target < 0 || (Number.isFinite(v.duration) && target > v.duration);
    cover.hidden = !outside;
    if (outside) {
      cover.textContent = target < 0 ? `This video starts in ${fmtTime(-target * 1000, 1)}` : "This video has ended";
      if (!v.paused) v.pause();
      return;
    }
    if (v.playbackRate !== rate) v.playbackRate = rate;
    if (playing) {
      if (v.paused) v.play().catch(() => {});
      if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = target;
    }
  }
}
