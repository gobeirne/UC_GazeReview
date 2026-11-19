import { describe, expect, test } from "vitest";
import { bytesSource, indexWebm } from "../src/video/webm";

const vint = (n: number) => {
  for (let len = 1; len <= 8; len++) if (n < 2 ** (7 * len) - 1) {
    const b = new Uint8Array(len); let v = n;
    for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
    b[0] |= 0x80 >> (len - 1); return b;
  }
  throw new Error("too big");
};
const UNKNOWN = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const idBytes = (id: number) => { const a: number[] = []; while (id) { a.unshift(id & 0xff); id = Math.floor(id / 256); } return new Uint8Array(a); };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const el = (id: number, ...data: Uint8Array[]) => { const d = cat(...data); return cat(idBytes(id), vint(d.length), d); };
const elU = (id: number, ...data: Uint8Array[]) => cat(idBytes(id), UNKNOWN, ...data);
const uint = (n: number) => new Uint8Array([n]);
const f64 = (x: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; };
const str = (s: string) => new TextEncoder().encode(s);
const block = (track: number, rel: number, key: boolean, payload: number[]) => {
  const b = new Uint8Array(4 + payload.length);
  b[0] = 0x80 | track; new DataView(b.buffer).setInt16(1, rel); b[3] = key ? 0x80 : 0; b.set(payload, 4);
  return el(0xa3, b);
};

describe("WebM index", () => {
  test("handles unknown-size Segment and Clusters, two tracks, keyframes", async () => {
    const file = cat(
      el(0x1a45dfa3, el(0x4282, str("webm"))),
      elU(0x18538067,
        el(0x1549a966, el(0x2ad7b1, new Uint8Array([0x0f, 0x42, 0x40])), el(0x4489, f64(400))),
        el(0x1654ae6b,
          el(0xae, el(0xd7, uint(1)), el(0x83, uint(2)), el(0x86, str("A_OPUS"))),
          el(0xae, el(0xd7, uint(2)), el(0x83, uint(1)), el(0x86, str("V_VP9")), el(0xe0, el(0xb0, uint(64)), el(0xba, uint(48))))),
        elU(0x1f43b675, el(0xe7, uint(0)), block(2, 0, true, [0x82, 0x49, 0x83]), block(1, 5, true, [1, 2]), block(2, 33, false, [0x86, 0, 0]), block(2, 67, false, [0x86, 1, 1])),
        elU(0x1f43b675, el(0xe7, uint(100)), block(2, 0, true, [0x82, 9, 9]), block(2, 33, false, [0x86, 2]))));
    const ix = await indexWebm(bytesSource(file));
    expect(ix.codecId).toBe("V_VP9");
    expect(ix.width).toBe(64);
    expect(ix.height).toBe(48);
    expect(ix.durationMs).toBe(400);
    expect(ix.frames.map((f) => f.t)).toEqual([0, 33, 67, 100, 133]);
    expect(ix.frames.map((f) => f.key)).toEqual([true, false, false, true, false]);
    expect(ix.codecCandidates[0]).toBe("vp09.00.10.08");
    const f = ix.frames[3];
    expect(Array.from(file.subarray(f.offset, f.offset + f.size))).toEqual([0x82, 9, 9]);
  });
  test("rejects non-WebM data", async () => {
    await expect(indexWebm(bytesSource(new Uint8Array([0, 0, 0, 0, 1, 2])))).rejects.toThrow(/EBML/);
  });
});
