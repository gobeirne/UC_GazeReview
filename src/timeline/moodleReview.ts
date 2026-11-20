/**
 * Reads a saved Moodle attempt review page (its HTML source, with the per-question
 * Response history tables) into the event timeline format. Ported from the standalone
 * moodle_quiz_timeline.html processor, producing the same v1 structure, with one change:
 * times are handled as plain clock times (no time zone), so elapsed seconds can't be
 * shifted by the browser's time zone or a daylight-saving change.
 */
import { clockStamp, TIMELINE_FORMAT, type TimelineEvent, type TimelineFile } from "./eventTimeline";

const normalise = (s: string | null | undefined) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const preserve = (s: string | null | undefined) => (s || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
const txt = (n: Element | null) => (n ? normalise(n.textContent) : "");

/** "5/11/26, 09:02:10" (day/month/year by default) → clock ms and stamp. */
function parseMoodleTime(s: string, order: "dmy" | "mdy"): { ms: number; local: string; original: string } | null {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(am|pm))?/i);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  const day = order === "mdy" ? b : a, month = order === "mdy" ? a : b;
  const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  let hour = +m[4];
  const ampm = (m[7] || "").toLowerCase();
  if (ampm) hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  const minute = +m[5], second = +(m[6] || 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  if (d.getUTCDate() !== day || d.getUTCMonth() + 1 !== month) return null;
  return { ms, local: clockStamp(ms), original: String(s).trim() };
}

/** Removes anything that could load or run before parsing (the document is never displayed). */
function inertSource(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(?:link|base|meta)\b[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/\s(?:src|srcset|data-src|poster)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function plainFromElement(el: Element | null): string {
  if (!el) return "";
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll("script,style,svg").forEach((n) => n.remove());
  copy.querySelectorAll("img").forEach((n) => n.replaceWith(n.getAttribute("alt") ? `[image: ${n.getAttribute("alt")}]` : "[image]"));
  copy.querySelectorAll("br").forEach((n) => n.replaceWith("\n"));
  copy.querySelectorAll("p,li,tr").forEach((n) => n.appendChild(copy.ownerDocument.createTextNode("\n")));
  return preserve(copy.textContent).replace(/\n{3,}/g, "\n\n");
}

function getChoices(q: Element): { letter: string; value: string }[] {
  const options: { letter: string; value: string }[] = [];
  q.querySelectorAll('.answer [data-region="answer-label"]').forEach((label) => {
    const letter = txt(label.querySelector(".answernumber")).replace(/[^a-z]/gi, "").toUpperCase();
    const value = txt(label.querySelector(".flex-fill") || label);
    if (letter && value) options.push({ letter, value });
  });
  return options;
}

function optionLetter(answer: string, options: { letter: string; value: string }[]): string | null {
  if (!options.length) return null;
  const value = normalise(answer);
  for (const o of options) if (normalise(o.value) === value) return o.letter;
  const direct = value.match(/^([a-z])[.)]?(?:\s|$)/i);
  if (direct && (value.length <= 3 || options.some((o) => o.letter === direct[1].toUpperCase() && value.slice(direct[0].length).trim() === o.value))) return direct[1].toUpperCase();
  return null;
}

function historyRows(q: Element): { time: string; action: string; step: string }[] {
  const table = q.querySelector(".history .generaltable") || q.querySelector(".history table") || q.querySelector("table.generaltable");
  if (!table) return [];
  const head = Array.from(table.querySelectorAll("thead th")).map(txt).map((v) => v.toLowerCase());
  const timeIx = head.indexOf("time"), actionIx = head.indexOf("action"), stepIx = head.indexOf("step");
  if (timeIx < 0 || actionIx < 0) return [];
  return Array.from(table.querySelectorAll("tbody tr")).map((row) => {
    const cells = Array.from(row.querySelectorAll(":scope > td"));
    const val = (i: number) => (i >= 0 && cells[i] ? plainFromElement(cells[i]) : "");
    return { time: val(timeIx), action: val(actionIx), step: val(stepIx) };
  });
}

export function looksLikeHtml(text: string): boolean {
  return /<(?:html|div|table|body|h3)\b/i.test(text);
}

export function parseMoodleReview(raw: string, order: "dmy" | "mdy" = "dmy"): TimelineFile {
  const doc = new DOMParser().parseFromString(inertSource(raw), "text/html");
  const nodes = Array.from(doc.querySelectorAll(".que"));
  if (!nodes.length) throw new Error("No question blocks were found. Use the source of the attempt review page, not the summary.");
  type Ev = TimelineEvent & { _ms: number };
  const all: Ev[] = [], starts: number[] = [], finishes: number[] = [];
  let numbered = 0, withHistory = 0;
  for (const q of nodes) {
    const qno = q.querySelector(".info .qno");
    if (!qno) continue;
    const questionNumber = parseInt(txt(qno), 10);
    if (!Number.isFinite(questionNumber)) continue;
    numbered++;
    const slotMatch = (q.id || "").match(/-(\d+)$/);
    const slot = slotMatch ? Number(slotMatch[1]) : null;
    const questionText = plainFromElement(q.querySelector(".qtext"));
    const choices = getChoices(q);
    const rows = historyRows(q);
    if (rows.length) withHistory++;
    const saves: Ev[] = [];
    for (const row of rows) {
      const time = parseMoodleTime(row.time, order);
      if (!time) continue;
      const action = row.action.trim();
      if (/^Started\b/i.test(action)) { starts.push(time.ms); continue; }
      if (/^Attempt finished\b/i.test(action)) { finishes.push(time.ms); continue; }
      const saved = action.match(/^(?:Saved|Auto-?saved|Automatically saved):\s*([\s\S]*)$/i);
      if (!saved) continue;
      saves.push({
        time: time.local, time_display: time.original, _ms: time.ms,
        question_number: questionNumber, question_slot: slot,
        history_step: Number(row.step) || null, answer: preserve(saved[1]),
        option_letter: optionLetter(saved[1], choices), question_text: questionText,
        save_number: 0, change_type: "first_save",
      });
    }
    saves.sort((a, b) => a._ms - b._ms || (a.history_step || 0) - (b.history_step || 0));
    saves.forEach((ev, i) => {
      ev.save_number = i + 1;
      ev.change_type = i === 0 ? "first_save" : normalise(ev.answer) === normalise(saves[i - 1].answer) ? "resave" : "revision";
      all.push(ev);
    });
  }
  if (!withHistory) throw new Error("Questions were found but not their Response history tables. Open the review with the response histories shown, then save the page source.");
  if (!all.length) throw new Error("Response histories were found but no saved responses.");
  all.sort((a, b) => a._ms - b._ms || a.question_number - b.question_number || (a.history_step || 0) - (b.history_step || 0));
  const start = starts.length ? Math.min(...starts) : all[0]._ms;
  const finish = finishes.length ? Math.min(...finishes) : all[all.length - 1]._ms;
  for (const ev of all) ev.seconds_from_start = Math.round((ev._ms - start) / 1000);
  const events: TimelineEvent[] = all.map(({ _ms, ...ev }) => ev);
  return {
    format: TIMELINE_FORMAT,
    time_basis: "Moodle displayed local time (no timezone offset inferred)",
    attempt: {
      quiz_title: txt(doc.querySelector("title")),
      started: clockStamp(start), finished: clockStamp(finish),
      duration_seconds: Math.round((finish - start) / 1000),
      questions_found: numbered, questions_with_response_history: withHistory,
      questions_with_saves: new Set(events.map((x) => x.question_number)).size,
      save_events: events.length,
      changed_answer_events: events.filter((x) => x.change_type === "revision").length,
      repeated_same_answer_events: events.filter((x) => x.change_type === "resave").length,
    },
    events,
  };
}
