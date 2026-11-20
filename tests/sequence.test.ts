import { describe, expect, test } from "vitest";
import { anchorTime, buildEpisodes, sequenceStats } from "../src/analysis/sequence";
import { defaultGate, gateSegments, opusDurationMs } from "../src/audio/envelope";

const items = [
  { label: "Q1", changed: false, from: 0, save: 60_000 },
  { label: "Q2", changed: false, from: 60_000, save: 120_000 },
  { label: "Q3", changed: false, from: 120_000, save: 180_000 },
];

describe("sequences per item", () => {
  test("anchors follow the fixed rules", () => {
    const eps = buildEpisodes(items,
      [{ start: 50_000, end: 51_000 }, { start: 110_000, end: 110_700 }], // automatic looks in Q1, Q2
      [{ start: 171_000, end: 171_800 }],                                 // a manual look in Q3
      [{ start: 168_000, end: 170_000 }],                                 // eyes obscured in Q3
      [{ start: 40_000, end: 46_000 }, { start: 100_000, end: 106_000 }, { start: 160_000, end: 166_000 }],
      [119_400], "both");
    expect(eps.map((e) => e.glance?.start)).toEqual([50_000, 110_000, 171_000]);
    expect(eps.map((e) => e.speechEnd)).toEqual([46_000, 106_000, 166_000]);
    expect(eps[1].submit).toBe(119_400);
    expect(eps[1].submitSource).toBe("seen");
    expect(anchorTime(eps[2], "glance")).toBe(171_000);
    const s = sequenceStats(eps);
    expect(s.withSequence).toBe(3);
    expect(s.speechToGlance).toBe(4_000);
  });
  test("leaving out manual looks shows how much depends on them", () => {
    const eps = buildEpisodes(items, [], [{ start: 171_000, end: 171_800 }], [{ start: 168_000, end: 170_000 }],
      [{ start: 160_000, end: 166_000 }], [], "auto");
    expect(eps[2].glance).toBeUndefined();
    const s = sequenceStats(eps);
    expect(s.speechNoLook).toBe(1);
    expect(s.obscuredNoLook).toBe(1);
  });
});

describe("noise gate", () => {
  test("bridges pauses between words and drops clicks", () => {
    const db = new Float32Array(500).fill(-60);
    for (let i = 50; i < 150; i++) if (i % 15 !== 0) db[i] = -20;  // speech with brief dips
    for (let i = 200; i < 203; i++) db[i] = -10;                    // a 60 ms click
    const env = { binMs: 20, db };
    const segs = gateSegments(env, defaultGate(env), 400, 250);
    expect(segs).toEqual([{ start: 1000, end: 3000 }]);
  });
  test("Opus packet durations", () => {
    expect(opusDurationMs(251, 3)).toBe(60);   // CELT 20 ms × 3 frames
    expect(opusDurationMs(0xfc, undefined)).toBe(20); // config 31, one frame
  });
});
