import type { Interval } from "./intervals";
import { median } from "./periEvent";

/**
 * One row per item (save moment): what happened between the previous save and this one.
 * Looks are automatic (from gaze tracking) or manual (marked by the reviewer); stretches where the
 * eyes were obscured are shown but never counted as looks.
 */
export interface SeqLook { start: number; end: number; manual: boolean }
export interface Episode {
  label: string;
  changed: boolean;
  from: number;
  submit: number;
  /** "seen" = marked by the reviewer; "saved" = the platform's save time. */
  submitSource: "seen" | "saved";
  looks: SeqLook[];
  obscured: Interval[];
  speech: Interval[];
  /** Anchors (video ms) by the fixed rules; undefined if the item doesn't have one. */
  glance?: SeqLook;
  speechEnd?: number;
  /** Gaze was analysed for the whole item (else automatic looks can't be judged; hand marks still count). */
  analysed: boolean;
}

export type LookFilter = "auto" | "both" | "manual";
export type Anchor = "speech" | "glance" | "submit";

export interface EpisodeInput {
  label: string;
  changed: boolean;
  from: number;
  save: number;
}

/**
 * Anchor rules (fixed in advance, documented in exports):
 * - submit: a "submit seen" mark between the previous save and 3 s after this save, else the save;
 * - glance: the last look starting after the previous save and at or before the submit;
 * - speech end: the end of the last speech stretch ending after the previous save and at or before
 *   the start of the glance (or the submit, if there is no glance).
 */
export function buildEpisodes(items: EpisodeInput[], autoLooks: Interval[], manualLooks: Interval[], obscured: Interval[],
  speech: Interval[], submitsSeen: number[], filter: LookFilter, coverage?: Interval[]): Episode[] {
  const looksAll: SeqLook[] = [
    ...(filter !== "manual" ? autoLooks.map((l) => ({ ...l, manual: false })) : []),
    ...(filter !== "auto" ? manualLooks.map((l) => ({ ...l, manual: true })) : []),
  ].sort((a, b) => a.start - b.start);
  return items.map((it) => {
    const seen = submitsSeen.filter((t) => t > it.from && t <= it.save + 3000);
    const submit = seen.length ? seen[seen.length - 1] : it.save;
    const inItem = (a: number) => a > it.from && a <= submit;
    const looks = looksAll.filter((l) => inItem(l.start));
    const glance = looks.length ? looks[looks.length - 1] : undefined;
    const sp = speech.filter((s) => s.end > it.from && s.start < submit).map((s) => ({ start: s.start, end: s.end }));
    const limit = glance ? glance.start : submit;
    const before = sp.filter((s) => s.end <= limit);
    return {
      label: it.label, changed: it.changed, from: it.from, submit, submitSource: seen.length ? "seen" : "saved",
      looks, obscured: obscured.filter((o) => o.end > it.from && o.start < submit), speech: sp,
      glance, speechEnd: before.length ? before[before.length - 1].end : undefined,
      analysed: !coverage || coverage.some((c) => it.from >= c.start - 1000 && submit <= c.end + 1000),
    } as Episode;
  });
}

export function anchorTime(e: Episode, a: Anchor): number | undefined {
  return a === "submit" ? e.submit : a === "glance" ? e.glance?.start : e.speechEnd;
}

export interface SequenceStats {
  items: number;
  /** Items whose gaze was analysed in full, or that have a look marked by hand. */
  judged: number;
  itemsWithLook: number;
  obscuredOnly: number;      // judged items with no look but the eyes obscured
  neither: number;           // judged items with neither (the exceptions to check)
  withSequence: number;      // speech, then a look, then submit
  speechNoLook: number;      // speech and submit but no look
  lookNoSpeech: number;      // a look but no speech before it
  noLookNoSpeech: number;
  obscuredNoLook: number;    // no look, but eyes obscured during the item
  multipleLooks: number;
  speechToGlance: number;    // median ms, speech end → glance start
  glanceToSubmit: number;    // median ms, glance end → submit
  submitsSeen: number;
}

/** Judged items (gaze analysed in full or a hand-marked look) with at least one of these looks. */
export function itemsWithLooks(eps: Episode[], looks: Interval[]): number {
  return eps.filter((e) => (e.analysed || e.looks.length) && looks.some((l) => l.start > e.from && l.start <= e.submit)).length;
}

export function sequenceStats(eps: Episode[]): SequenceStats {
  const all = eps;
  eps = eps.filter((e) => e.analysed || e.looks.length);
  const withSeq = eps.filter((e) => e.glance && e.speechEnd !== undefined);
  return {
    items: all.length,
    judged: eps.length,
    itemsWithLook: eps.filter((e) => e.glance).length,
    obscuredOnly: eps.filter((e) => !e.glance && e.obscured.length).length,
    neither: eps.filter((e) => !e.glance && !e.obscured.length).length,
    withSequence: withSeq.length,
    speechNoLook: eps.filter((e) => !e.glance && e.speech.length).length,
    lookNoSpeech: eps.filter((e) => e.glance && e.speechEnd === undefined).length,
    noLookNoSpeech: eps.filter((e) => !e.glance && !e.speech.length).length,
    obscuredNoLook: eps.filter((e) => !e.glance && e.obscured.length).length,
    multipleLooks: eps.filter((e) => e.looks.length > 1).length,
    speechToGlance: median(withSeq.map((e) => e.glance!.start - e.speechEnd!)),
    glanceToSubmit: median(eps.filter((e) => e.glance).map((e) => e.submit - e.glance!.end)),
    submitsSeen: eps.filter((e) => e.submitSource === "seen").length,
  };
}

/**
 * comparisons: for each other place, the number of judged items with at least one look there,
 * to set the consistency of looks to the target against looks elsewhere.
 */
export function statsLines(s: SequenceStats, target: string, comparisons: { name: string; items: number }[] = []): string[] {
  const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–");
  const pc = (k: number) => (s.judged ? ` (${Math.round((100 * k) / s.judged)}%)` : "");
  return [
    `Items: ${s.items}; judged: ${s.judged} (gaze analysed in full, or a look marked by hand)${s.submitsSeen ? `; ${s.submitsSeen} with the submit marked from the video` : ""}`,
    `Items with at least one look to ${target}: ${s.itemsWithLook} of ${s.judged}${pc(s.itemsWithLook)}`,
    `Items with no look but the eyes obscured: ${s.obscuredOnly}; with neither: ${s.neither}`,
    ...(comparisons.length ? [`For comparison, items with a look to ${comparisons.map((c) => `${c.name}: ${c.items} of ${s.judged}`).join("; ")}`] : []),
    `Speech, then a look to ${target}, then submit: ${s.withSequence} of ${s.judged}`,
    `Speech and submit with no look: ${s.speechNoLook}`,
    `A look with no speech before it: ${s.lookNoSpeech}; neither: ${s.noLookNoSpeech}`,
    `Items with more than one look: ${s.multipleLooks}`,
    `Median time from the end of speech to the look: ${sec(s.speechToGlance)}; from the end of the look to submit: ${sec(s.glanceToSubmit)}`,
  ];
}
