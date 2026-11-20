import { median, positionSentence, pText, SHUFFLES, type PeriResult, type PositionResult } from "../analysis/periEvent";
import type { GazeModelInfo } from "../analysis/gazeModel";
import type { Recording } from "../store/types";
import type { TimelineEvent } from "../timeline/eventTimeline";
import { esc, fmtTime } from "../ui/util";

export interface RegionSummary { name: string; colour: string; looks: number; timeMs: number; isScreen: boolean }

export interface EventRow {
  event: TimelineEvent;
  videoMs: number;
  change: string;
  /** Time from the most recent look to each non-screen region (by name) to the event, within 60 s (ms), if any. */
  lastLook: Record<string, number | null>;
  analysed: boolean;
}

export interface ReportData {
  rec: Recording;
  model: GazeModelInfo;
  analysedMs: number;
  gazeMs: number;
  regions: RegionSummary[];
  unlabelledLooks: number;
  target: string;
  peri: PeriResult;
  rows: EventRow[];
  includeText: boolean;
  figurePng: string;
  caption: string;
  positions?: PositionResult;
}

/** One-sentence result used in the figure caption and the report. */
export function resultSentence(target: string, p: PeriResult): string {
  const lat = median(p.latencies);
  return `${p.eventsWithLook} of ${p.events} save moments had a look to ${target} in the ${p.windowMs / 1000} s before (saves within 2 s of each other count as one moment). ` +
    `With the same number of moments placed at random times in the analysed video, ${p.eventsWithLookMean.toFixed(1)} would on average; ${pText(p)}.` +
    (p.latencies.length ? ` Median time from the last such look to the save: ${(lat / 1000).toFixed(1)} s.` : "");
}

export function figureCaption(target: string, p: PeriResult, panelA: "aligned" | "staircase" = "aligned", pos?: PositionResult): string {
  if (panelA === "staircase") return `A: Each row is one save moment, in order (several items saved together share a row; * = a changed response). The bar is the time from the previous save to this one (grey where not analysed), with its last ${p.windowMs / 1000} s shaded; the blue line is the save and the dark bars are looks to ${target}. Below, left: where in its item each look started, against an even spread; right: looks per 5 s around the saves, with the range expected by chance. ` +
    `B: Where gaze fell during the timeline, with the labelled regions. ` + (pos?.items ? positionSentence(target, pos) + " " : "") + resultSentence(target, p) + " A saved response marks when the answer was submitted, not when it was chosen.";
  return `A: Each row is one save moment with an analysed minute before it (several items saved together share a row; * = a changed response); each tick is a look to ${target}, ` +
    `aligned to the moment the response was saved (dashed line); the shaded strip is the ${p.windowMs / 1000} s before. Below, looks per 5 s bin with the range expected if ` +
    `the responses had been saved at random times. B: Where gaze fell over the whole analysed video, with the labelled regions. ` +
    resultSentence(target, p) + " A saved response marks when the answer was submitted, not when it was chosen.";
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mins = (ms: number) => `${(ms / 60000).toFixed(1)} min`;

export function buildReportHtml(d: ReportData): string {
  const rec = d.rec, tl = rec.timeline!, m = d.model, s = rec.settings;
  const regionNames = d.regions.filter((r) => !r.isScreen).map((r) => r.name);
  const now = new Date();
  const rows = d.rows.map((r) => {
    const e = r.event;
    return `<tr${e.change_type === "revision" ? ' class="rev"' : ""}>
      <td class="num">${fmtTime(r.videoMs, 0)}</td><td class="num">${esc(e.time.slice(11))}</td><td>Q${e.question_number}</td>
      ${d.includeText ? `<td>${esc(e.option_letter ? `${e.option_letter}: ${e.answer}` : e.answer)}</td>` : ""}
      <td>${esc(r.change)}</td>
      ${regionNames.map((n) => `<td class="num">${!r.analysed ? "–" : r.lastLook[n] == null ? "" : `${(r.lastLook[n]! / 1000).toFixed(1)} s`}</td>`).join("")}
    </tr>`;
  }).join("");
  const items = d.includeText ? Array.from(new Map(tl.data.events.map((e) => [e.question_number, e.question_text ?? ""])).entries())
    .filter(([, t]) => t).map(([q, t]) => `<dt>Q${q}</dt><dd>${esc(t)}</dd>`).join("") : "";
  return `<!doctype html>
<html lang="en-NZ"><head><meta charset="utf-8"><title>Gaze review report: ${esc(rec.name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #17212b; max-width: 1050px; margin: 32px auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 8px; border-bottom: 1px solid #d8dee3; padding-bottom: 4px; }
  .muted { color: #5d6a75; } .num { font-variant-numeric: tabular-nums; text-align: right; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { padding: 4px 8px; border-bottom: 1px solid #e3e8ec; text-align: left; vertical-align: top; }
  th { color: #5d6a75; font-weight: 600; } tr.rev td { background: #fdf3ea; }
  dl.summary { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; } dl.summary dt { color: #5d6a75; } dl.summary dd { margin: 0; }
  .result { font-size: 16px; background: #f1f6fb; border-left: 4px solid #1d5fa8; padding: 10px 14px; }
  img { width: 100%; height: auto; border: 1px solid #d8dee3; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  dl.items dt { font-weight: 600; margin-top: 8px; } dl.items dd { margin: 0 0 0 0; white-space: pre-wrap; }
  @media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } img, table { break-inside: avoid; } }
</style></head><body>
<h1>Gaze review report</h1>
<p class="muted">${esc(rec.name)}${rec.fileName ? ` · ${esc(rec.fileName)}` : ""} · generated ${now.toLocaleString("en-NZ")}</p>

<h2>Result</h2>
${d.positions?.items ? `<p class="result">${esc(positionSentence(d.target, d.positions))}</p>` : ""}
<p class="result">${esc(resultSentence(d.target, d.peri))}</p>

<h2>Summary</h2>
<dl class="summary">
  <dt>Video analysed</dt><dd>${mins(d.analysedMs)}; gaze measured in ${pct(d.gazeMs / Math.max(1, d.analysedMs))} of it</dd>
  <dt>Event timeline</dt><dd>${esc(tl.data.attempt.quiz_title || tl.fileName)}: ${tl.data.events.length} saved responses (${tl.data.events.filter((e) => e.change_type === "revision").length} changed) from ${esc(tl.data.attempt.started.replace("T", " "))} to ${esc(tl.data.attempt.finished.replace("T", " "))}</dd>
  <dt>Responses counted</dt><dd>${d.peri.events} moments, each with the minute before and 10 s after it analysed (saves within 2 s of each other count as one moment)</dd>
  <dt>Looks counted</dt><dd>to ${esc(d.target)}</dd>
  <dt>Looks in the ${d.peri.windowMs / 1000} s before responses</dt><dd>${d.peri.looksBefore} (counting every look; chance range ${d.peri.sumLo}–${d.peri.sumHi})</dd>
</dl>

<h2>Figure</h2>
<img src="${d.figurePng}" alt="${esc(d.caption)}">

<h2>Where gaze went</h2>
<table><thead><tr><th>Region</th><th class="num">Looks</th><th class="num">Time</th><th class="num">Share of time with gaze</th></tr></thead><tbody>
${d.regions.map((r) => `<tr><td><span class="swatch" style="background:${r.colour}"></span>${esc(r.name)}${r.isScreen ? " (screen)" : ""}</td><td class="num">${r.isScreen ? "" : r.looks}</td><td class="num">${mins(r.timeMs)}</td><td class="num">${pct(r.timeMs / Math.max(1, d.gazeMs))}</td></tr>`).join("")}
<tr><td><span class="swatch" style="background:#e07b00"></span>Elsewhere (unlabelled)</td><td class="num">${d.unlabelledLooks}</td><td></td><td></td></tr>
</tbody></table>
<p class="muted">A look is a run of at least ${s.minFrames} frames away from the screen.</p>

<h2>Saved responses</h2>
<table><thead><tr><th class="num">Video</th><th class="num">Clock</th><th>Item</th>${d.includeText ? "<th>Response</th>" : ""}<th>Change</th>${regionNames.map((n) => `<th class="num">Last look to ${esc(n)} before</th>`).join("")}</tr></thead>
<tbody>${rows}</tbody></table>
<p class="muted">Last look: time from the start of the most recent look to that region in the minute before the save. Blank: none in that minute. –: not analysed.</p>
${items ? `<h2>Item wording</h2><dl class="items">${items}</dl>` : ""}

<h2>How the video and timeline were lined up</h2>
<dl class="summary">
  <dt>Video started at</dt><dd>${esc((rec.sync?.startClock ?? "").replace("T", " "))}</dd>
  <dt>Set by</dt><dd>${esc(rec.sync?.method ?? "")}</dd>
  ${rec.sync?.note ? `<dt>Note</dt><dd>${esc(rec.sync.note)}</dd>` : ""}
</dl>

<h2>Method</h2>
<p>Each video frame was analysed in the browser with the MediaPipe Face Landmarker. Head direction (relative to the line from the face to the camera) and eye direction were combined into a gaze angle from the camera. The eye scale was ${m.kH.toFixed(0)}°/unit horizontally (${esc(m.kHSource)}) and ${m.kV.toFixed(0)}°/unit vertically (${esc(m.kVSource)}).
${m.distanceCorrected ? "Angles were rescaled to the person’s usual distance from the camera to allow for leaning in and out." : "Angles were not corrected for distance from the camera."}
Slow posture changes were followed over a ${s.driftWindowS} s window.
${s.blinkFilter ? `Blinks (lids below ${s.blinkLidPct}% of usual for up to ${s.blinkMaxMs} ms) were removed from the eye trace (${m.blinksRemoved} removed).` : "Blinks were not removed."}
Regions were drawn by the reviewer on the gaze plane.
${s.lookMode === "stretches"
  ? "For the event analysis, looks were formed with every region treated as an ordinary region: a look is a stretch of frames outside the main on-screen cluster, credited to the region it spends most frames in, so brief crossings into a region are not counted separately."
  : `A look is a run of at least ${s.minFrames} frames away from the screen region, credited to the labelled region it spends most frames in.`}
${s.minLookMs ? ` Looks shorter than ${s.minLookMs / 1000} s were left out.` : ""}${s.minRegionFrames ? ` Looks with fewer than ${s.minRegionFrames} frames inside the region were left out.` : ""}</p>
<p>For the test, each saved response with its whole window analysed was counted as having a look if a look to ${esc(d.target)} started in the ${d.peri.windowMs / 1000} s before it. Chance was estimated by placing the same number of responses at random times in the analysed video ${SHUFFLES} times (fixed seed) and counting the same way. The p value is the share of placements with at least as many responses with a look, with one added to both counts.</p>

<p>Where in each item looks fell needs no window: each item runs from the previous save to its own, and a look's position is how far through the item it started. Each item with looks contributes the median position of its looks, so a burst of looks within one item counts once. The main test compares the average of these values with the 50% expected if looks were unrelated to answering, using 100,000 simulations in which each item's value is a single random position; treating each item's looks as one burst in this way gives the widest spread chance could have, so the test does not overstate the result. A one-sided sign test (items above halfway) is given as well. Only items analysed from start to end are used.</p>

<h2>Limits</h2>
<ul>
  <li>Response times are when the answer was saved (on moving on, or an autosave), to the second, not when it was chosen.</li>
  <li>The lining up of video and timeline is only as good as the start time used (above).</li>
  <li>Gaze angles from a webcam are approximate (several degrees), and depend on lighting, glasses and how much of the face is in view. Gaze was measured in ${pct(m.validFraction)} of analysed frames.</li>
  <li>The test assumes that, without a link to the responses, looks would be as likely at any time. Looks that cluster for other reasons (for example at the start of each item) can make the result look stronger.</li>
  <li>Every look counted here should be checked in the video.</li>
</ul>
<p class="muted">Gaze review · ${now.toISOString().slice(0, 10)}</p>
</body></html>`;
}

export function buildCsv(d: ReportData): string {
  const regionNames = d.regions.filter((r) => !r.isScreen).map((r) => r.name);
  const q = (v: string | number | null | undefined) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["video_seconds", "clock_time", "item", "save_number", "change_type", ...(d.includeText ? ["option_letter", "response"] : []),
    ...regionNames.map((n) => `last_look_to_${n.replace(/\W+/g, "_").toLowerCase()}_seconds_before`), "window_analysed"];
  const lines = d.rows.map((r) => [
    (r.videoMs / 1000).toFixed(2), r.event.time, r.event.question_number, r.event.save_number, r.event.change_type,
    ...(d.includeText ? [r.event.option_letter ?? "", r.event.answer] : []),
    ...regionNames.map((n) => (r.lastLook[n] == null ? "" : (r.lastLook[n]! / 1000).toFixed(2))),
    r.analysed ? "yes" : "no",
  ].map(q).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
