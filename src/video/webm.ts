/**
 * Minimal WebM/Matroska demuxer: walks the file once and returns the video track's
 * codec settings plus an index of every video frame (timestamp, byte range, keyframe).
 *
 * Browser-recorded WebM (MediaRecorder, as used by web recording tools) often has no Cues
 * (seek index), unknown-size Segment and Cluster elements, and sometimes no Duration.
 * The walk below copes with all of these: master elements are entered rather than
 * skipped, so an unknown size never needs resolving. Frame payloads are not kept.
 */

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function fileSource(file: Blob): ByteSource {
  return {
    size: file.size,
    async read(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, async read(o, l) { return bytes.subarray(o, Math.min(bytes.length, o + l)); } };
}

export interface FrameEntry {
  /** Presentation time, ms from the start of the recording. */
  t: number;
  offset: number;
  size: number;
  key: boolean;
}

export interface WebmIndex {
  codecId: string;
  /** WebCodecs codec strings to try, best first. */
  codecCandidates: string[];
  description?: Uint8Array;
  width: number;
  height: number;
  /** From the header if present, otherwise the last frame's time plus one interval. */
  durationMs: number;
  frames: FrameEntry[];
  /** Laced blocks are not expected in video and are skipped; counted here. */
  skippedLaced: number;
  /** The file's DateUTC header (when the muxer says the file was made), ms since 1970 UTC. */
  dateUtcMs?: number;
  /** The first audio track, if any: codec settings and its blocks (timestamps in ms, byte ranges). */
  audio?: { codecId: string; codecPrivate?: Uint8Array; sampleRate: number; channels: number; frames: { t: number; offset: number; size: number }[] };
}

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489, DateUTC: 0x4461,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Cluster: 0x1f43b675, Timecode: 0xe7,
  SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1,
};
/** Elements we step into instead of over. */
const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.BlockGroup]);

class Reader {
  private buf: Uint8Array = new Uint8Array(0);
  private start = 0;
  constructor(private src: ByteSource, private window = 4 << 20) {}
  get size() { return this.src.size; }
  async bytes(pos: number, len: number): Promise<Uint8Array> {
    if (pos < this.start || pos + len > this.start + this.buf.length) {
      this.start = pos;
      this.buf = await this.src.read(pos, Math.max(len, this.window));
    }
    return this.buf.subarray(pos - this.start, pos - this.start + len);
  }
}

/** Reads an EBML variable-length integer. Returns value (marker kept for IDs), length, and whether all value bits are 1. */
function vint(b: Uint8Array, i: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === (0xff >> len);
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[i + k];
    if (b[i + k] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array): number { let v = 0; for (const x of b) v = v * 256 + x; return v; }
function readFloat(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0) : b.length === 8 ? dv.getFloat64(0) : NaN;
}
function readString(b: Uint8Array): string { return new TextDecoder().decode(b).replace(/\0+$/, ""); }

interface Track { number: number; type: number; codecId: string; codecPrivate?: Uint8Array; width: number; height: number; sampleRate?: number; channels?: number }

export async function indexWebm(src: ByteSource, onProgress?: (fraction: number) => void): Promise<WebmIndex> {
  const r = new Reader(src);
  let timecodeScale = 1_000_000; // ns per tick (default 1 ms)
  let durationTicks = NaN;
  let dateUtcMs: number | undefined;
  const tracks: Track[] = [];
  let track: Track | null = null;
  let clusterTc = 0;
  let videoTrack = -1;
  let audioTrack = -1;
  const audioRaw: { tc: number; offset: number; size: number }[] = [];
  const raw: { tc: number; offset: number; size: number; flagKey: boolean | null }[] = [];
  let skippedLaced = 0;
  let blockGroupDepthEnd = -1;
  const header = await r.bytes(0, 4);
  if (readUint(header) !== ID.EBML) throw new Error("Not a WebM/Matroska file (no EBML header).");

  let pos = 0;
  let lastReport = 0;
  while (pos < r.size) {
    const h = await r.bytes(pos, Math.min(16, r.size - pos));
    const id = vint(h, 0, true);
    if (!id) break;
    const sz = vint(h, id.len, false);
    if (!sz) break;
    const dataStart = pos + id.len + sz.len;
    const size = sz.unknown ? -1 : sz.value;

    if (track && id.value !== ID.TrackEntry && pos >= (track as Track & { end: number }).end) { tracks.push(track); track = null; }
    if (blockGroupDepthEnd >= 0 && pos >= blockGroupDepthEnd) blockGroupDepthEnd = -1;

    if (MASTERS.has(id.value)) {
      if (id.value === ID.TrackEntry) {
        if (track) tracks.push(track);
        track = Object.assign({ number: 0, type: 0, codecId: "", width: 0, height: 0 }, { end: size < 0 ? Infinity : dataStart + size });
      }
      if (id.value === ID.Tracks && size >= 0) {
        // nothing extra: children are walked in place
      }
      if (id.value === ID.BlockGroup) blockGroupDepthEnd = size < 0 ? Infinity : dataStart + size;
      if (id.value === ID.Cluster && videoTrack < 0) {
        if (track) { tracks.push(track); track = null; }
        const v = tracks.find((t) => t.type === 1);
        if (!v) throw new Error("No video track found.");
        videoTrack = v.number;
        audioTrack = tracks.find((t) => t.type === 2)?.number ?? -1;
      }
      pos = dataStart;
      continue;
    }
    if (size < 0) throw new Error(`Unknown-size element 0x${id.value.toString(16)} at byte ${pos}.`);

    switch (id.value) {
      case ID.TimecodeScale: timecodeScale = readUint(await r.bytes(dataStart, size)); break;
      case ID.Duration: durationTicks = readFloat(await r.bytes(dataStart, size)); break;
      case ID.DateUTC: {
        // Signed nanoseconds since 2001-01-01T00:00:00 UTC.
        const b = await r.bytes(dataStart, size);
        if (size === 8) dateUtcMs = Date.UTC(2001, 0, 1) + Number(new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0) / 1_000_000n);
        break;
      }
      case ID.TrackNumber: if (track) track.number = readUint(await r.bytes(dataStart, size)); break;
      case ID.TrackType: if (track) track.type = readUint(await r.bytes(dataStart, size)); break;
      case ID.CodecID: if (track) track.codecId = readString(await r.bytes(dataStart, size)); break;
      case ID.CodecPrivate: if (track) track.codecPrivate = (await r.bytes(dataStart, size)).slice(); break;
      case ID.PixelWidth: if (track) track.width = readUint(await r.bytes(dataStart, size)); break;
      case ID.PixelHeight: if (track) track.height = readUint(await r.bytes(dataStart, size)); break;
      case ID.SamplingFrequency: if (track) track.sampleRate = readFloat(await r.bytes(dataStart, size)); break;
      case ID.Channels: if (track) track.channels = readUint(await r.bytes(dataStart, size)); break;
      case ID.Timecode: clusterTc = readUint(await r.bytes(dataStart, size)); break;
      case ID.SimpleBlock:
      case ID.Block: {
        const b = await r.bytes(dataStart, Math.min(size, 16));
        const tn = vint(b, 0, false);
        if (!tn) break;
        if (tn.value === audioTrack && audioTrack >= 0) {
          const relA = new DataView(b.buffer, b.byteOffset + tn.len, 2).getInt16(0);
          const flagsA = b[tn.len + 2];
          const hdrA = tn.len + 3;
          if (!(flagsA & 0x06)) audioRaw.push({ tc: clusterTc + relA, offset: dataStart + hdrA, size: size - hdrA });
          else {
            // Laced block (several audio frames in one block): split it into frames.
            const head = await r.bytes(dataStart, Math.min(size, 4096));
            for (const f of unlace(head, hdrA, size, (flagsA >> 1) & 3)) audioRaw.push({ tc: clusterTc + relA, offset: dataStart + f.offset, size: f.size });
          }
          break;
        }
        if (tn.value !== videoTrack) break;
        const rel = new DataView(b.buffer, b.byteOffset + tn.len, 2).getInt16(0);
        const flags = b[tn.len + 2];
        const hdr = tn.len + 3;
        if (flags & 0x06) { skippedLaced++; break; }
        raw.push({
          tc: clusterTc + rel,
          offset: dataStart + hdr,
          size: size - hdr,
          flagKey: id.value === ID.SimpleBlock ? !!(flags & 0x80) : null,
        });
        break;
      }
    }
    pos = dataStart + size;
    if (onProgress && pos - lastReport > 8 << 20) { lastReport = pos; onProgress(pos / r.size); }
  }
  if (track) tracks.push(track);
  const v = tracks.find((t) => t.type === 1);
  if (!v) throw new Error("No video track found.");
  if (!raw.length) throw new Error("The video track contains no frames.");

  const msPerTick = timecodeScale / 1e6;
  const codecId = v.codecId;
  const frames: FrameEntry[] = [];
  for (const f of raw) {
    let key = f.flagKey;
    if (key === null) key = await bitstreamKey(r, codecId, f.offset, f.size);
    frames.push({ t: f.tc * msPerTick, offset: f.offset, size: f.size, key });
  }
  if (!frames[0].key) frames[0].key = await bitstreamKey(r, codecId, frames[0].offset, frames[0].size);

  const profile = codecId === "V_VP9" ? await vp9Profile(r, frames.find((f) => f.key) ?? frames[0]) : 0;
  const sorted = [...frames].map((f) => f.t).sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((t, i) => t - sorted[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const medInt = intervals.length ? intervals[intervals.length >> 1] : 33;
  const durationMs = Number.isFinite(durationTicks) && durationTicks > 0 ? durationTicks * msPerTick : sorted[sorted.length - 1] + medInt;
  onProgress?.(1);
  return {
    codecId,
    codecCandidates: codecCandidates(codecId, v.codecPrivate, profile),
    description: codecId === "V_VP9" || codecId === "V_VP8" ? undefined : v.codecPrivate,
    width: v.width,
    height: v.height,
    durationMs,
    frames,
    skippedLaced,
    dateUtcMs,
    audio: (() => {
      const a = tracks.find((t) => t.type === 2);
      if (!a || !audioRaw.length) return undefined;
      return { codecId: a.codecId, codecPrivate: a.codecPrivate, sampleRate: a.sampleRate || 48000, channels: a.channels || 1, frames: audioRaw.map((f) => ({ t: f.tc * msPerTick, offset: f.offset, size: f.size })) };
    })(),
  };
}

/** Frames of a laced block: lacing 1 = Xiph, 2 = fixed size, 3 = EBML. Offsets are from the block's data start. */
export function unlace(b: Uint8Array, start: number, blockSize: number, lacing: number): { offset: number; size: number }[] {
  const count = b[start] + 1;
  let p = start + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    for (let i = 0; i < count - 1; i++) { let sz = 0, x: number; do { x = b[p++]; sz += x; } while (x === 255); sizes.push(sz); }
  } else if (lacing === 3) {
    const first = vint(b, p, false)!; p += first.len; sizes.push(first.value);
    for (let i = 1; i < count - 1; i++) {
      const d = vint(b, p, false)!; p += d.len;
      const bias = 2 ** (7 * d.len - 1) - 1; // signed difference from the previous size
      sizes.push(sizes[i - 1] + (d.value - bias));
    }
  } else if (lacing === 2) {
    const each = (blockSize - p) / count;
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  const used = sizes.reduce((a, x) => a + x, 0);
  sizes.push(blockSize - p - used);
  const out: { offset: number; size: number }[] = [];
  let o = p;
  for (const sz of sizes) { out.push({ offset: o, size: sz }); o += sz; }
  return out;
}

async function bitstreamKey(r: Reader, codecId: string, offset: number, size: number): Promise<boolean> {
  const b = await r.bytes(offset, Math.min(size, 4));
  if (codecId === "V_VP8") return (b[0] & 0x01) === 0;
  if (codecId === "V_VP9") {
    // frame_marker(2) profile_low(1) profile_high(1) [reserved(1) if profile 3] show_existing(1) frame_type(1)
    const byte = b[0];
    const profile = ((byte >> 5) & 1) | (((byte >> 4) & 1) << 1);
    let bit = 3;
    if (profile === 3) bit--;
    const showExisting = (byte >> bit) & 1;
    const frameType = (byte >> (bit - 1)) & 1;
    return !showExisting && frameType === 0;
  }
  return false;
}

async function vp9Profile(r: Reader, f: FrameEntry): Promise<number> {
  const b = await r.bytes(f.offset, 1);
  return ((b[0] >> 5) & 1) | (((b[0] >> 4) & 1) << 1);
}

function hex2(n: number) { return n.toString(16).padStart(2, "0"); }

export function codecCandidates(codecId: string, priv: Uint8Array | undefined, vp9profile: number): string[] {
  switch (codecId) {
    case "V_VP8": return ["vp8"];
    case "V_VP9": {
      const p = `0${vp9profile}`;
      const depth = vp9profile >= 2 ? "10" : "08";
      return [`vp09.${p}.10.${depth}`, `vp09.${p}.31.${depth}`, `vp09.${p}.41.${depth}`, `vp09.${p}.51.${depth}`, "vp9"];
    }
    case "V_AV1": return ["av01.0.04M.08", "av01.0.08M.08", "av01.0.12M.08", "av01.1.08M.08"];
    case "V_MPEG4/ISO/AVC":
      if (priv && priv.length >= 4) return [`avc1.${hex2(priv[1])}${hex2(priv[2])}${hex2(priv[3])}`, "avc1.42E01E", "avc1.640028"];
      return ["avc1.42E01E", "avc1.640028"];
    default: return [];
  }
}

/** Typical interval between frames (median of positive differences), ms. */
export function medianFrameInterval(frames: FrameEntry[]): number {
  const t = frames.map((f) => f.t).sort((a, b) => a - b);
  const d = t.slice(1).map((x, i) => x - t[i]).filter((x) => x > 0).sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : 33.3;
}
