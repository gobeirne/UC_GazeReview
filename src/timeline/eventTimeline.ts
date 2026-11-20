/**
 * Event timelines: timestamped events to show against the video, such as the saved
 * responses in a Moodle attempt's response history ("moodle-quiz-response-timeline/v1",
 * produced by the standalone timeline processor or by importing the review page here).
 *
 * Times in that format are wall-clock times with no time zone. They are only ever
 * compared with other wall-clock times (the recording's start), as plain clock
 * arithmetic, so time zones and daylight saving never enter into it.
 */

export const TIMELINE_FORMAT = "moodle-quiz-response-timeline/v1";

export interface TimelineEvent {
  time: string;                 // YYYY-MM-DDTHH:mm:ss, wall clock, no zone
  time_display?: string;
  seconds_from_start?: number;
  question_number: number;
  question_slot?: number | null;
  history_step?: number | null;
  save_number: number;
  change_type: "first_save" | "revision" | "resave";
  answer: string;
  option_letter?: string | null;
  question_text?: string;
  [k: string]: unknown;         // kept verbatim
}

export interface TimelineFile {
  format: string;
  time_basis?: string;
  attempt: {
    quiz_title?: string;
    started: string;
    finished: string;
    duration_seconds?: number;
    save_events?: number;
    [k: string]: unknown;
  };
  events: TimelineEvent[];
}

export interface StoredTimeline {
  fileName: string;
  importedAt: number;
  data: TimelineFile;
  /** Notes from checking the file on import (count or elapsed-time mismatches). */
  warnings: string[];
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Wall-clock stamp → ms on a zone-free scale (only differences are meaningful). */
export function clockMs(stamp: string): number {
  const m = STAMP.exec(stamp);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function clockStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Checks an imported object and returns it with warnings. Throws if it can't be used. */
export function checkTimeline(o: unknown): { data: TimelineFile; warnings: string[] } {
  const d = o as TimelineFile;
  if (!d || typeof d !== "object") throw new Error("The file is not a JSON object.");
  if (typeof d.format !== "string" || !d.format.startsWith("moodle-quiz-response-timeline/")) throw new Error("This is not an event timeline file (unknown format).");
  if (d.format !== TIMELINE_FORMAT) throw new Error(`Unsupported timeline version “${d.format}”; this version reads ${TIMELINE_FORMAT}.`);
  if (!d.attempt || !Array.isArray(d.events)) throw new Error("The timeline has no attempt details or no events.");
  const warnings: string[] = [];
  const start = clockMs(d.attempt.started);
  if (!Number.isFinite(start)) throw new Error("The timeline’s start time is missing or not in YYYY-MM-DDTHH:mm:ss form.");
  d.events.forEach((e, i) => {
    if (!Number.isFinite(clockMs(e.time))) throw new Error(`Event ${i + 1} has no usable time.`);
    if (typeof e.question_number !== "number") throw new Error(`Event ${i + 1} has no item number.`);
    if (typeof e.answer !== "string") e.answer = String(e.answer ?? "");
  });
  if (typeof d.attempt.save_events === "number" && d.attempt.save_events !== d.events.length)
    warnings.push(`The file says it has ${d.attempt.save_events} events but contains ${d.events.length}.`);
  const off = d.events.filter((e) => typeof e.seconds_from_start === "number" && Math.abs((clockMs(e.time) - start) / 1000 - e.seconds_from_start!) > 1).length;
  if (off) warnings.push(`${off} event${off === 1 ? "’s" : "s’"} elapsed time differs from its clock time (a time-zone or daylight-saving mismatch when the file was made); clock times are used.`);
  const fin = clockMs(d.attempt.finished);
  if (Number.isFinite(fin) && typeof d.attempt.duration_seconds === "number" && Math.abs((fin - start) / 1000 - d.attempt.duration_seconds) > 1)
    warnings.push("The stated duration differs from the start and finish times; the times are used.");
  return { data: d, warnings };
}

/** Previous saved answer of the same item, for showing what changed. */
export function previousAnswer(events: TimelineEvent[], i: number): TimelineEvent | null {
  const e = events[i];
  let best: TimelineEvent | null = null;
  for (const x of events) if (x.question_number === e.question_number && x.save_number === e.save_number - 1) best = x;
  return best;
}

/** Short label for an answer: its option letter if known, else trimmed text; empty means cleared. */
export function answerLabel(e: TimelineEvent, max = 40): string {
  if (e.option_letter) return e.option_letter;
  const t = e.answer.replace(/\s+/g, " ").trim();
  if (!t) return "(cleared)";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
