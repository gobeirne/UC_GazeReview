import type { Interval } from "./intervals";

/** Window around each event (ms), bin width, and the "just before" window for the event-based test. */
export const BEFORE = 60_000, AFTER = 10_000, BIN = 5_000, JUST_BEFORE = 10_000, SHUFFLES = 500;

export interface PeriResult {
  /** The "just before" window used (ms). */
  windowMs: number;
  /** Events whose whole window was analysed (the ones counted), as indexes into the input. */
  used: number[];
  events: number;
  /** Look onsets per bin, and the chance mean / 2.5th / 97.5th percentiles per bin. */
  observed: number[]; mean: number[]; lo: number[]; hi: number[];
  /** Looks in the JUST_BEFORE window summed over events, and the chance 95% range of that sum. */
  looksBefore: number; looksBeforeMean: number; sumLo: number; sumHi: number;
  /** Events with at least one look in the JUST_BEFORE window, and the chance distribution of that count. */
  eventsWithLook: number; eventsWithLookMean: number; eventsWithLookHi: number;
  /** Share of shuffles with at least as many events with a look: (k + 1) / (SHUFFLES + 1). */
  p: number; shufflesAtLeast: number;
  /** Per counted event: looks relative to it, as [onset, duration] (ms; onset within the window). */
  raster: [number, number][][];
  /** For events with a look just before: time from the last look's start to the event (ms). */
  latencies: number[];
}

/**
 * Looks around events, against chance. Each event's window runs from 60 s before to 10 s after;
 * only events whose whole window was analysed are counted. Chance: the same number of events
 * placed at random times in the analysed video (windows also fully analysed), 500 times, with a
 * fixed seed so the figures are reproducible.
 *
 * Two summaries are given. Counting looks pools bursts: several looks in a few seconds all count,
 * which widens the chance range. Counting events with at least one look in the 10 s before is
 * unaffected by bursts, and is the main test.
 */
/**
 * prevTimes (optional, aligned with eventTimes): the previous save before each event. When given,
 * looks at or before the previous save are not counted for an event, so each look belongs to the
 * item being answered when it happened and isn't counted again for the next item. Random
 * placements are treated the same way (each against the previous random time).
 */
export function periEvent(eventTimes: number[], looks: number[], coverage: Interval[], frameMs: number, durations?: number[], windowMs = JUST_BEFORE, prevTimes?: number[], placeWithin?: Interval): PeriResult {
  const nb = (BEFORE + AFTER) / BIN;
  const jb0 = (BEFORE - windowMs) / BIN, jb1 = BEFORE / BIN; // bins covering the window before
  const lead = prevTimes ? Math.min(BEFORE, windowMs) : BEFORE; // with counting since the previous save, only the window itself must be analysed
  const inside = (t: number) => coverage.some((c) => t - lead >= c.start - frameMs && t + AFTER <= c.end + frameMs);
  const used = eventTimes.map((t, i) => ({ t, i })).filter((x) => Number.isFinite(x.t) && inside(x.t));
  const order = looks.map((_, i) => i).sort((a, b) => looks[a] - looks[b]);
  const sorted = order.map((i) => looks[i]);
  const durs = order.map((i) => durations?.[i] ?? 0);
  const lowerBound = (x: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
  const measure = (times: number[], keepRaster: boolean, prevs?: number[]) => {
    const h = new Array(nb).fill(0);
    let hits = 0;
    const raster: [number, number][][] = [], latencies: number[] = [];
    times.forEach((t, ti) => {
      const row: [number, number][] = [];
      let lastBefore = -Infinity;
      const from = prevs && Number.isFinite(prevs[ti]) ? Math.max(t - BEFORE, prevs[ti] + 1) : t - BEFORE;
      for (let k = lowerBound(from); k < sorted.length && sorted[k] < t + AFTER; k++) {
        const d = sorted[k] - t;
        h[Math.floor((d + BEFORE) / BIN)]++;
        if (keepRaster) row.push([d, durs[k]]);
        if (d >= -windowMs && d < 0) lastBefore = Math.max(lastBefore, d);
      }
      if (lastBefore > -Infinity) { hits++; latencies.push(-lastBefore); }
      if (keepRaster) raster.push(row);
    });
    return { h, hits, raster, latencies };
  };
  const obs = measure(used.map((x) => x.t), true, prevTimes ? used.map((x) => prevTimes[x.i]) : undefined);
  // Random placements: anywhere a whole window fits in analysed video, limited to placeWithin if given
  // (e.g. the span of the event timeline, so other parts of the recording don't set the baseline).
  const clipped = placeWithin ? coverage.map((c) => ({ start: Math.max(c.start, placeWithin.start), end: Math.min(c.end, placeWithin.end) })).filter((c) => c.end > c.start) : coverage;
  const spans = clipped.map((c) => ({ a: c.start + lead, b: c.end - AFTER })).filter((s) => s.b > s.a);
  const total = spans.reduce((s, x) => s + (x.b - x.a), 0);
  const runs: number[][] = [], sums: number[] = [], hitRuns: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  if (used.length && total > 0) {
    for (let k = 0; k < SHUFFLES; k++) {
      const ts = used.map(() => {
        let x = rnd() * total;
        for (const s of spans) { const len = s.b - s.a; if (x < len) return s.a + x; x -= len; }
        return spans[spans.length - 1].b;
      });
      let m;
      if (prevTimes) { ts.sort((a, b) => a - b); m = measure(ts, false, ts.map((_, i) => (i ? ts[i - 1] : NaN))); }
      else m = measure(ts, false);
      runs.push(m.h);
      sums.push(m.h.slice(jb0, jb1).reduce((a, b) => a + b, 0));
      hitRuns.push(m.hits);
    }
  }
  const pct = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const meanOf = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const atLeast = hitRuns.filter((x) => x >= obs.hits).length;
  return {
    windowMs,
    used: used.map((x) => x.i),
    events: used.length,
    observed: obs.h,
    mean: obs.h.map((_, b) => meanOf(runs.map((r) => r[b]))),
    lo: obs.h.map((_, b) => pct(runs.map((r) => r[b]), 0.025)),
    hi: obs.h.map((_, b) => pct(runs.map((r) => r[b]), 0.975)),
    looksBefore: obs.h.slice(jb0, jb1).reduce((a, b) => a + b, 0),
    looksBeforeMean: meanOf(sums),
    sumLo: pct(sums, 0.025), sumHi: pct(sums, 0.975),
    eventsWithLook: obs.hits,
    eventsWithLookMean: meanOf(hitRuns),
    eventsWithLookHi: pct(hitRuns, 0.975),
    p: hitRuns.length ? (atLeast + 1) / (hitRuns.length + 1) : NaN,
    shufflesAtLeast: atLeast,
    raster: obs.raster,
    latencies: obs.latencies,
  };
}

/** "p = 0.004" or "none of 500 shuffles reached it (p < 0.002)". */
export function pText(r: PeriResult): string {
  if (!Number.isFinite(r.p)) return "";
  if (r.shufflesAtLeast === 0) return `none of ${SHUFFLES} random placements did as well (p < ${(1 / (SHUFFLES + 1)).toFixed(3)})`;
  return `${r.shufflesAtLeast} of ${SHUFFLES} random placements did as well (p = ${r.p.toFixed(3)})`;
}

export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Saves within gapMs of each other (several items saved by one page submission, or a final
 * "submit all") are one moment of behaviour. Counting each separately would count the same
 * looks several times and make the test look stronger than it is, so they are merged into one
 * event at the time of the first. Input must be in time order. Returns groups of indexes.
 */
export function groupEvents(times: number[], gapMs = 2000): { t: number; members: number[] }[] {
  const groups: { t: number; members: number[] }[] = [];
  times.forEach((t, i) => {
    const last = groups[groups.length - 1];
    if (last && Number.isFinite(t) && t - times[last.members[last.members.length - 1]] <= gapMs) last.members.push(i);
    else groups.push({ t, members: [i] });
  });
  return groups;
}

export interface PositionResult {
  /** Items (save moments) whose whole time was analysed and that had at least one look. */
  items: number;
  /** Of those, items whose looks fall mostly in the second half (median position > 0.5). */
  lateItems: number;
  /** One-sided sign test: chance of at least lateItems of items if positions were uniform. */
  p: number;
  /** Median over items of each item's median look position (0 = start of the item, 1 = the save). */
  medianPosition: number;
  /** Look onsets in ten bins of position across all counted items, and the count expected per bin if uniform. */
  bins: number[];
  expectedPerBin: number;
  /** Items analysed in full, with or without looks. */
  analysedItems: number;
  /** Mean over items of each item's median look position, and its p value against looks timed independently of answering. */
  meanPosition: number;
  pMean: number;
  /** Simulations used for pMean, and how many reached the observed mean. */
  sims: number;
  simsAtLeast: number;
}

/**
 * Where in each item the looks fall, without any window to choose. An item runs from the previous
 * save to its own save; a look's position is how far through the item it starts (0 to 1). If looks
 * had nothing to do with answering, positions would be spread evenly; if they come just before
 * answering, they bunch near 1. Each item with looks gives one value (the median position of its
 * looks), so bursts within an item count once, and a sign test asks how many items have that value
 * above 0.5. Only items analysed from start to end are used.
 */
export function itemPositions(items: { from: number; to: number }[], looks: number[], coverage: Interval[], frameMs: number): PositionResult {
  const analysed = (a: number, b: number) => coverage.some((c) => a >= c.start - frameMs && b <= c.end + frameMs);
  const sorted = looks.slice().sort((a, b) => a - b);
  const bins = new Array(10).fill(0);
  const perItem: number[] = [];
  let analysedItems = 0, total = 0;
  for (const it of items) {
    if (!(it.to > it.from) || !analysed(it.from, it.to)) continue;
    analysedItems++;
    const us = sorted.filter((l) => l > it.from && l <= it.to).map((l) => (l - it.from) / (it.to - it.from));
    if (!us.length) continue;
    for (const u of us) bins[Math.min(9, Math.floor(u * 10))]++;
    total += us.length;
    perItem.push(median(us));
  }
  const n = perItem.length, k = perItem.filter((u) => u > 0.5).length;
  // Mean position test. Under the null each item's value is one uniform position: as if all of an
  // item's looks were a single burst. That is the widest spread the null can have, so the test is
  // conservative about bursts (a median of several independent positions would cluster nearer 0.5).
  const mean = n ? perItem.reduce((a, b) => a + b, 0) / n : NaN;
  const SIMS = 100_000;
  let seed = 54321, atLeast = 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  if (n) for (let i = 0; i < SIMS; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += rnd();
    if (sum / n >= mean) atLeast++;
  }
  return {
    items: n, lateItems: k, p: n ? binomialUpper(k, n) : NaN,
    medianPosition: median(perItem), bins, expectedPerBin: total / 10, analysedItems,
    meanPosition: mean, pMean: n ? (atLeast + 1) / (SIMS + 1) : NaN, sims: SIMS, simsAtLeast: atLeast,
  };
}

/** P(X ≥ k) for X ~ Binomial(n, 0.5). */
function binomialUpper(k: number, n: number): number {
  let p = 0, c = 1; // c = C(n, i)
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = (c * (n - i + 1)) / i;
    if (i >= k) p += c;
  }
  return p / 2 ** n;
}

export function positionSentence(target: string, r: PositionResult): string {
  if (!r.items) return "";
  const fmtP = (p: number) => (p < 0.0001 ? p.toExponential(1).replace("e-", " × 10^-") : p.toFixed(4));
  const pm = r.simsAtLeast === 0 ? `none of ${r.sims.toLocaleString("en-NZ")} simulations reached it, p < ${(1 / (r.sims + 1)).toFixed(5)}` : `p = ${fmtP(r.pMean)}`;
  const ps = r.p < 0.0001 ? `p = ${fmtP(r.p)}` : `p = ${r.p.toFixed(4)}`;
  return `On average, looks to ${target} came ${Math.round(r.meanPosition * 100)}% of the way through their item, across ${r.items} items with looks (of ${r.analysedItems} analysed in full); ` +
    `if their timing had nothing to do with answering, the average would be 50% (${pm}). ` +
    `In ${r.lateItems} of the ${r.items} items most looks came in the second half (sign test, ${ps}).`;
}
