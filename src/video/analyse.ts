import type { MediaPipeFaceTracker } from "../tracking/MediaPipeFaceTracker";
import { Fingerprinter, measure, RunBuilder } from "../analysis/frame";
import type { Interval } from "../analysis/intervals";
import type { Run } from "../store/types";
import { medianFrameInterval, type ByteSource, type WebmIndex } from "./webm";

export async function fileIdentity(file: File): Promise<string> {
  const MB = 1 << 20;
  const head = await file.slice(0, MB).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - MB)).arrayBuffer();
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const all = new Uint8Array(sizeBytes.length + head.byteLength + tail.byteLength);
  all.set(sizeBytes, 0); all.set(new Uint8Array(head), sizeBytes.length); all.set(new Uint8Array(tail), sizeBytes.length + head.byteLength);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return "file-" + Array.from(d.slice(0, 12), (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function chooseDecoderConfig(ix: WebmIndex): Promise<VideoDecoderConfig> {
  if (typeof VideoDecoder === "undefined") throw new Error("This browser cannot decode video frame by frame (WebCodecs). Use a current Chrome, Edge, Firefox or Safari.");
  for (const codec of ix.codecCandidates) {
    const cfg: VideoDecoderConfig = { codec, codedWidth: ix.width, codedHeight: ix.height, ...(ix.description ? { description: ix.description } : {}) };
    try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try next */ }
  }
  throw new Error(`This browser cannot decode ${ix.codecId} video.`);
}

export interface AnalyseProgress { done: number; total: number; tMs: number }

/**
 * The face tracker's VIDEO mode needs strictly increasing timestamps whose spacing matches
 * the real frame spacing. Analysis, live playback tracking and screen capture all share
 * one tracker, so they share this clock: begin() marks a jump (a new stretch, a seek),
 * at() maps video time to tracker time within the stretch.
 */
class TrackerClock {
  private last = 0;
  private base = 0;
  private t0 = 0;
  begin(videoT: number) { this.base = this.last + 1000; this.t0 = videoT; }
  at(videoT: number) { const ts = Math.max(this.last + 1, Math.round(this.base + (videoT - this.t0))); this.last = ts; return ts; }
}
export const trackerClock = new TrackerClock();
const clock = trackerClock;

const WARMUP_MS = 1000;

/** Analysed frames are handed over for saving in pieces of this much video. */
const CHUNK_MS = 30_000;

export interface GapResult { frames: number; stopped: boolean; reachedMs: number }

/**
 * Decodes and tracks every frame in `gap`. Decoding starts at the keyframe at or before
 * gap.start − 1 s; frames before gap.start warm the tracker up and are discarded.
 *
 * Results are handed to onChunk every 30 s of video, so a long stretch is saved as it
 * goes. If analysis is stopped or fails, the frames done so far are handed over too,
 * covering up to the last analysed frame, and the next run carries on from there.
 */
export async function analyseGap(
  src: ByteSource, ix: WebmIndex, cfg: VideoDecoderConfig, gap: Interval, recId: string,
  tracker: MediaPipeFaceTracker, fpr: Fingerprinter,
  onProgress: (p: AnalyseProgress) => void, onChunk: (run: Run) => void, signal: AbortSignal,
): Promise<GapResult> {
  const frames = ix.frames;
  let first = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].t > gap.start - WARMUP_MS && i > 0) break;
    if (frames[i].key) first = i;
  }
  let last = frames.length - 1;
  for (let i = first; i < frames.length; i++) if (frames[i].t >= gap.end + 500) { last = i; break; }
  const total = frames.filter((f) => f.t >= gap.start && f.t < gap.end).length;

  const dt = medianFrameInterval(frames);
  let builder = new RunBuilder(recId, gap);
  let chunkStart = gap.start, lastT = NaN, count = 0;
  const queue: VideoFrame[] = [];
  let decodeError: unknown = null;
  let wake: (() => void) | null = null;
  const decoder = new VideoDecoder({
    output: (f) => { queue.push(f); wake?.(); },
    error: (e) => { decodeError = e; wake?.(); },
  });
  decoder.configure(cfg);
  clock.begin(frames[first].t);

  const process = (f: VideoFrame) => {
    const t = f.timestamp / 1000;
    try {
      if (t >= gap.start - WARMUP_MS && t < gap.end) {
        const res = tracker.detect(f, clock.at(t));
        if (t >= gap.start) {
          if (t >= chunkStart + CHUNK_MS && builder.count) {
            onChunk(builder.finish(t));
            chunkStart = t;
            builder = new RunBuilder(recId, { start: t, end: gap.end });
          }
          fpr.drawMid(f);
          builder.push(t, measure(res.raw), fpr.fingerprint());
          lastT = t; count++;
          onProgress({ done: count, total, tMs: t });
        }
      }
    } finally { f.close(); }
  };
  const drain = async (max: number) => {
    while (queue.length > max || decoder.decodeQueueSize > 6) {
      if (decodeError) throw decodeError;
      if (signal.aborted) throw new DOMException("Analysis stopped", "AbortError");
      const f = queue.shift();
      if (f) { process(f); if (count % 15 === 0) await new Promise((r) => setTimeout(r, 0)); continue; }
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
      wake = null;
    }
  };

  try {
    // Read the byte ranges in batches of up to 4 MB.
    let i = first;
    while (i <= last) {
      let j = i, end = frames[i].offset + frames[i].size;
      while (j + 1 <= last && frames[j + 1].offset + frames[j + 1].size - frames[i].offset < 4 << 20) { j++; end = Math.max(end, frames[j].offset + frames[j].size); }
      const bytes = await src.read(frames[i].offset, end - frames[i].offset);
      for (let k = i; k <= j; k++) {
        const f = frames[k];
        const data = bytes.subarray(f.offset - frames[i].offset, f.offset - frames[i].offset + f.size);
        decoder.decode(new EncodedVideoChunk({ type: f.key ? "key" : "delta", timestamp: Math.round(f.t * 1000), data }));
        await drain(4);
      }
      i = j + 1;
    }
    await decoder.flush();
    await drain(0);
    while (queue.length) process(queue.shift()!);
  } catch (e) {
    // Keep what was done: coverage ends at the next frame, which is where analysis resumes.
    const next = frames.find((f) => f.t > lastT)?.t ?? lastT + dt;
    if (builder.count) onChunk(builder.finish(next));
    if ((e as Error).name === "AbortError") return { frames: count, stopped: true, reachedMs: builder.count ? next : chunkStart };
    throw e;
  } finally {
    for (const f of queue) f.close();
    if (decoder.state !== "closed") decoder.close();
  }
  if (builder.count) onChunk(builder.finish(gap.end));
  return { frames: count, stopped: false, reachedMs: gap.end };
}
