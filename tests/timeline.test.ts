import { describe, expect, test } from "vitest";
import { timelineExample } from "./fixtures/timelineExample";
import { answerLabel, checkTimeline, clockMs, previousAnswer } from "../src/timeline/eventTimeline";
import { periEvent } from "../src/analysis/periEvent";

const example = () => JSON.parse(JSON.stringify(timelineExample));

describe("event timeline", () => {
  test("reads the synthetic example and places events against the video", () => {
    const { data, warnings } = checkTimeline(example());
    expect(warnings).toEqual([]);
    expect(data.events.length).toBe(7);
    // Video started 90 s before the timeline: Q1's first save (130 s in) is at video 3:40.
    const videoStart = clockMs(data.attempt.started) - 90_000;
    expect((clockMs(data.events[0].time) - videoStart) / 1000).toBe(220);
    const revision = data.events.findIndex((e) => e.question_number === 1 && e.change_type === "revision");
    expect(answerLabel(previousAnswer(data.events, revision)!)).toBe("C");
    expect(answerLabel(data.events[revision])).toBe("A");
  });
  test("works without item wording", () => {
    const o = example();
    for (const e of o.events) delete e.question_text;
    expect(checkTimeline(o).data.events.length).toBe(7);
  });
  test("rejects other formats and versions", () => {
    expect(() => checkTimeline({ format: "something-else" })).toThrow(/not an event timeline/);
    expect(() => checkTimeline({ ...example(), format: "moodle-quiz-response-timeline/v2" })).toThrow(/Unsupported/);
  });
  test("warns when stated counts or elapsed times don't match the clock times", () => {
    const o = example();
    o.attempt.save_events = 8;
    o.events[0].seconds_from_start = 3730; // as if an hour out
    const w = checkTimeline(o).warnings;
    expect(w.some((x) => /8 events/.test(x))).toBe(true);
    expect(w.some((x) => /elapsed time differs/.test(x))).toBe(true);
  });
  test("clock arithmetic ignores time zones and daylight saving", () => {
    // 2027-04-04 03:00 is when NZ daylight saving ends; plain clock arithmetic doesn't care.
    expect((clockMs("2027-04-04T03:30:00") - clockMs("2027-04-04T01:30:00")) / 3600_000).toBe(2);
  });
});

describe("looks around events", () => {
  test("finds looks that come just before events, against a chance band", () => {
    const coverage = [{ start: 0, end: 1_800_000 }];
    const events = Array.from({ length: 20 }, (_, i) => 120_000 + i * 80_000);
    const looks = [...events.map((t) => t - 7_000), ...Array.from({ length: 20 }, (_, i) => 100_000 + i * 83_000)];
    const r = periEvent(events, looks, coverage, 33);
    expect(r.events).toBe(20);
    const before = r.observed[10] + r.observed[11];   // the 10 s before
    expect(before).toBeGreaterThanOrEqual(20);
    expect(before).toBeGreaterThan(r.sumHi);
  });
  test("leaves out events whose window isn't analysed", () => {
    const r = periEvent([30_000, 500_000], [], [{ start: 0, end: 600_000 }], 33);
    expect(r.events).toBe(1);
  });
});

describe("event-based test", () => {
  test("counts responses with a look just before, robust to bursts", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    const coverage = [{ start: 0, end: 3_600_000 }];
    const events = Array.from({ length: 35 }, (_, i) => 120_000 + i * 95_000);
    // 10 of the 35 responses have a burst of 3 looks 4–6 s before; plus a few unrelated looks.
    const looks = [...events.slice(0, 10).flatMap((t) => [t - 6000, t - 5000, t - 4000]), 450_000, 1_450_000, 2_950_000];
    const r = pe(events, looks, coverage, 33);
    expect(r.events).toBe(35);
    expect(r.eventsWithLook).toBe(10);
    expect(r.looksBefore).toBe(30);
    expect(r.p).toBeLessThan(0.01);
    expect(r.latencies.every((x) => x === 4000)).toBe(true);
    expect(r.raster.length).toBe(35);
    expect(r.raster[0]).toEqual([[-6000, 0], [-5000, 0], [-4000, 0]]);
  });
  test("no relation gives an unremarkable p", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    const coverage = [{ start: 0, end: 3_600_000 }];
    const events = Array.from({ length: 35 }, (_, i) => 120_000 + i * 95_000);
    const looks = Array.from({ length: 60 }, (_, i) => 70_000 + i * 58_731);
    expect(pe(events, looks, coverage, 33).p).toBeGreaterThan(0.05);
  });
});

describe("look durations", () => {
  test("the raster keeps each look's length", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    const r = pe([100_000], [95_000, 97_000], [{ start: 0, end: 200_000 }], 33, [1200, 66]);
    expect(r.raster[0]).toEqual([[-5000, 1200], [-3000, 66]]);
  });
});

describe("saves at the same moment", () => {
  test("are merged into one event", async () => {
    const { groupEvents } = await import("../src/analysis/periEvent");
    const g = groupEvents([10_000, 70_000, 70_400, 71_000, 140_000]);
    expect(g.map((x) => x.members)).toEqual([[0], [1, 2, 3], [4]]);
    expect(g[1].t).toBe(70_000);
  });
  test("a wider window catches looks further before the save", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    const r10 = pe([100_000], [86_000], [{ start: 0, end: 200_000 }], 33, undefined, 10_000);
    const r15 = pe([100_000], [86_000], [{ start: 0, end: 200_000 }], 33, undefined, 15_000);
    expect(r10.eventsWithLook).toBe(0);
    expect(r15.eventsWithLook).toBe(1);
  });
});

describe("count each look once", () => {
  test("a look before the previous save isn't counted again", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    // Saves 30 s apart; one look 8 s before each save.
    const saves = [100_000, 130_000, 160_000];
    const looks = saves.map((t) => t - 8_000);
    const cov = [{ start: 0, end: 300_000 }];
    const all = pe(saves, looks, cov, 33, undefined, 15_000);
    const once = pe(saves, looks, cov, 33, undefined, 15_000, [60_000, 100_000, 130_000]);
    // Without truncation the 160 s row also shows the look at 122 s (the previous item's); with it, only its own.
    expect(all.raster[2].length).toBe(2);
    expect(once.raster[2].length).toBe(1);
    expect(once.eventsWithLook).toBe(3);
  });
  test("chance placements stay inside the given span", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    // Lots of looks outside the span inflate chance unless placements are limited to the span.
    const saves = Array.from({ length: 20 }, (_, i) => 1_000_000 + i * 60_000);
    const looks = [...saves.map((t) => t - 5_000), ...Array.from({ length: 400 }, (_, i) => i * 2_400)];
    const cov = [{ start: 0, end: 2_300_000 }];
    const prevs = saves.map((t, i) => (i ? saves[i - 1] : 960_000));
    const wide = pe(saves, looks, cov, 33, undefined, 15_000, prevs);
    const inSpan = pe(saves, looks, cov, 33, undefined, 15_000, prevs, { start: 960_000, end: 2_200_000 });
    expect(inSpan.eventsWithLookMean).toBeLessThan(wide.eventsWithLookMean);
    expect(inSpan.p).toBeLessThan(0.01);
  });
});

describe("where in each item looks fall", () => {
  test("looks just before each save are late in their items", async () => {
    const { itemPositions } = await import("../src/analysis/periEvent");
    const saves = Array.from({ length: 30 }, (_, i) => 60_000 + i * 90_000);
    const items = saves.map((t, i) => ({ from: i ? saves[i - 1] : 0, to: t }));
    const looks = saves.flatMap((t) => [t - 12_000, t - 9_000]);
    const r = itemPositions(items, looks, [{ start: 0, end: 3_000_000 }], 33);
    expect(r.items).toBe(30);
    expect(r.lateItems).toBe(30);
    expect(r.p).toBeLessThan(1e-6);
    expect(r.bins[8] + r.bins[9]).toBe(60);
  });
  test("evenly spread looks give an unremarkable result", async () => {
    const { itemPositions } = await import("../src/analysis/periEvent");
    const saves = Array.from({ length: 30 }, (_, i) => 60_000 + i * 90_000);
    const items = saves.map((t, i) => ({ from: i ? saves[i - 1] : 0, to: t }));
    const looks = saves.map((t, i) => t - (i % 2 ? 20_000 : 70_000));
    const r = itemPositions(items, looks, [{ start: 0, end: 3_000_000 }], 33);
    expect(r.p).toBeGreaterThan(0.2);
  });
  test("items not analysed in full are left out", async () => {
    const { itemPositions } = await import("../src/analysis/periEvent");
    const r = itemPositions([{ from: 0, to: 100_000 }, { from: 100_000, to: 200_000 }], [95_000, 195_000], [{ start: 50_000, end: 300_000 }], 33);
    expect(r.analysedItems).toBe(1);
  });
});

describe("mean position test", () => {
  test("is far stronger than the window test for late looks of varying lead", async () => {
    const { itemPositions } = await import("../src/analysis/periEvent");
    // 30 items of 90 s; looks 5–40 s before each save (late in the item, often outside a 10 s window).
    const saves = Array.from({ length: 30 }, (_, i) => 60_000 + i * 90_000);
    const items = saves.map((t, i) => ({ from: i ? saves[i - 1] : 0, to: t }));
    const looks = saves.map((t, i) => t - (5_000 + (i * 7_919) % 35_000));
    const r = itemPositions(items, looks, [{ start: 0, end: 3_000_000 }], 33);
    expect(r.meanPosition).toBeGreaterThan(0.7);
    expect(r.simsAtLeast).toBe(0);
    expect(r.pMean).toBeLessThan(1e-4);
  });
  test("looks spread through items give a mean near 0.5 and no effect", async () => {
    const { itemPositions } = await import("../src/analysis/periEvent");
    const saves = Array.from({ length: 30 }, (_, i) => 60_000 + i * 90_000);
    const items = saves.map((t, i) => ({ from: i ? saves[i - 1] : 0, to: t }));
    const looks = saves.map((t, i) => t - 90_000 * ((i * 0.618) % 1) + 1);
    const r = itemPositions(items, looks, [{ start: 0, end: 3_000_000 }], 33);
    expect(r.pMean).toBeGreaterThan(0.05);
  });
});
