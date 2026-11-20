import type { ByteSource, WebmIndex } from "../video/webm";

/**
 * Sound level over time from the recording's audio track: the RMS level in 20 ms bins, in dB
 * relative to full scale. Decoded with WebCodecs (Opus), or with Web Audio as a fallback. Only the
 * level is kept, never the audio itself.
 */
export interface Envelope { binMs: number; db: Float32Array }

export const BIN_MS = 20;

/** Duration of an Opus packet from its TOC byte (and the frame-count byte for code 3), ms. */
export function opusDurationMs(b0: number, b1: number | undefined): number {
  const config = b0 >> 3, code = b0 & 3;
  const size = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
  const count = code === 0 ? 1 : code === 3 ? (b1 ?? 0) & 0x3f : 2;
  return size * Math.max(1, count);
}

export async function audioEnvelope(src: ByteSource, ix: WebmIndex, file: Blob | null, onProgress?: (f: number) => void): Promise<Envelope> {
  const a = ix.audio;
  if (!a) throw new Error("This video has no sound track.");
  const totalMs = Math.max(ix.durationMs, a.frames.length ? a.frames[a.frames.length - 1].t + 100 : 0);
  const nb = Math.ceil(totalMs / BIN_MS) + 1;
  const sum = new Float64Array(nb), cnt = new Float64Array(nb);
  const add = (startMs: number, rate: number, data: Float32Array) => {
    const perBin = (rate * BIN_MS) / 1000;
    let i = 0;
    while (i < data.length) {
      const tMs = startMs + (i / rate) * 1000;
      const bin = Math.floor(tMs / BIN_MS);
      const binEndSample = i + Math.max(1, Math.round(((bin + 1) * BIN_MS - tMs) / 1000 * rate));
      const end = Math.min(data.length, binEndSample);
      if (bin >= 0 && bin < nb) { let s = 0; for (let k = i; k < end; k++) s += data[k] * data[k]; sum[bin] += s; cnt[bin] += end - i; }
      i = end;
      void perBin;
    }
  };
  if (typeof AudioDecoder !== "undefined" && a.codecId === "A_OPUS") {
    const cfg: AudioDecoderConfig = { codec: "opus", sampleRate: a.sampleRate, numberOfChannels: a.channels, ...(a.codecPrivate ? { description: a.codecPrivate } : {}) };
    let ok = false;
    try { ok = !!(await AudioDecoder.isConfigSupported(cfg)).supported; } catch { ok = false; }
    if (ok) {
      let err: unknown = null;
      const dec = new AudioDecoder({
        output: (d) => {
          const rate = d.sampleRate, n = d.numberOfFrames;
          const buf = new Float32Array(n);
          try { d.copyTo(buf, { planeIndex: 0, format: "f32-planar" }); } catch { d.copyTo(buf, { planeIndex: 0 }); }
          add(d.timestamp / 1000, rate, buf);
          d.close();
        },
        error: (e) => { err = e; },
      });
      dec.configure(cfg);
      let clock = -Infinity;
      const frames = a.frames;
      for (let i = 0; i < frames.length;) {
        // Read up to 2 MB of consecutive packets at once.
        let j = i; const startOff = frames[i].offset;
        while (j + 1 < frames.length && frames[j + 1].offset + frames[j + 1].size - startOff < 2 << 20) j++;
        const bytes = await src.read(startOff, frames[j].offset + frames[j].size - startOff);
        for (let k = i; k <= j; k++) {
          const f = frames[k];
          const data = bytes.subarray(f.offset - startOff, f.offset - startOff + f.size);
          const t = Math.max(f.t, clock);
          clock = t + opusDurationMs(data[0], data[1]);
          dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(t * 1000), data }));
        }
        while (dec.decodeQueueSize > 50) await new Promise((r) => setTimeout(r, 0));
        onProgress?.(j / frames.length);
        i = j + 1;
      }
      await dec.flush();
      dec.close();
      if (err) throw err;
      return finish(sum, cnt);
    }
  }
  // Fallback: let the browser decode the whole file's audio (more memory).
  if (!file) throw new Error("This browser can’t decode the sound track.");
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  add(0, buf.sampleRate, buf.getChannelData(0));
  return finish(sum, cnt);
}

function finish(sum: Float64Array, cnt: Float64Array): Envelope {
  const db = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) db[i] = cnt[i] ? 10 * Math.log10(sum[i] / cnt[i] + 1e-12) : NaN;
  return { binMs: BIN_MS, db };
}

/** Level at the 20th percentile (the quiet background) and 95th percentile (loud), dB. */
export function levelStats(env: Envelope): { quiet: number; loud: number } {
  const v = Array.from(env.db).filter(Number.isFinite).sort((x, y) => x - y);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN);
  return { quiet: q(0.2), loud: q(0.95) };
}

/** Default gate: 12 dB above the quiet background. */
export function defaultGate(env: Envelope): number {
  const { quiet } = levelStats(env);
  return Number.isFinite(quiet) ? quiet + 12 : -40;
}

/**
 * Noise gate: stretches where the level is above the threshold. Gaps shorter than holdMs are
 * bridged (pauses between words); stretches shorter than minMs are dropped (clicks, bumps).
 */
export function gateSegments(env: Envelope, thresholdDb: number, holdMs = 400, minMs = 250): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = -1, lastOn = -1;
  for (let i = 0; i < env.db.length; i++) {
    const on = env.db[i] >= thresholdDb;
    if (on) { if (s < 0) s = i; lastOn = i; }
    else if (s >= 0 && (i - lastOn) * env.binMs > holdMs) { out.push({ start: s * env.binMs, end: (lastOn + 1) * env.binMs }); s = -1; }
  }
  if (s >= 0) out.push({ start: s * env.binMs, end: (lastOn + 1) * env.binMs });
  return out.filter((x) => x.end - x.start >= minMs);
}
