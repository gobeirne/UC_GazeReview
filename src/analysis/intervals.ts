/** Half-open time intervals [start, end) in ms, and set operations on sorted, disjoint lists of them. */
export interface Interval { start: number; end: number }

/** Sorts and merges overlapping or touching intervals (gaps ≤ tolerance are closed). */
export function normalise(list: Interval[], tolerance = 0): Interval[] {
  const s = list.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of s) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + tolerance) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function union(a: Interval[], b: Interval[]): Interval[] { return normalise([...a, ...b]); }

/** Parts of `want` not already in `have`. Pieces shorter than minLength are dropped. */
export function subtract(want: Interval, have: Interval[], minLength = 0): Interval[] {
  let pieces: Interval[] = [{ ...want }];
  for (const h of normalise(have)) {
    const next: Interval[] = [];
    for (const p of pieces) {
      if (h.end <= p.start || h.start >= p.end) { next.push(p); continue; }
      if (h.start > p.start) next.push({ start: p.start, end: h.start });
      if (h.end < p.end) next.push({ start: h.end, end: p.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.end - p.start > minLength);
}

export function contains(list: Interval[], t: number): boolean {
  // list is normalised: binary search
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (t < list[m].start) hi = m - 1;
    else if (t >= list[m].end) lo = m + 1;
    else return true;
  }
  return false;
}

export function totalLength(list: Interval[]): number { return list.reduce((s, i) => s + (i.end - i.start), 0); }

export function intersect(a: Interval, b: Interval): Interval | null {
  const s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
  return e > s ? { start: s, end: e } : null;
}
