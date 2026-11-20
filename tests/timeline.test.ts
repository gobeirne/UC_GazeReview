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
    expect(r.raster[0]).toEqual([-6000, -5000, -4000]);
  });
  test("no relation gives an unremarkable p", async () => {
    const { periEvent: pe } = await import("../src/analysis/periEvent");
    const coverage = [{ start: 0, end: 3_600_000 }];
    const events = Array.from({ length: 35 }, (_, i) => 120_000 + i * 95_000);
    const looks = Array.from({ length: 60 }, (_, i) => 70_000 + i * 58_731);
    expect(pe(events, looks, coverage, 33).p).toBeGreaterThan(0.05);
  });
});
