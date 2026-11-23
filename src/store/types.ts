/**
 * Everything saved per recording. Video is never stored: only per-frame measurements,
 * a 16×12 thumbnail fingerprint per frame (for aligning screen captures), and the
 * reviewer's segments, regions and settings.
 */

/** Per-frame measurements kept for each analysed frame (NaN = not available). */
export const FIELDS = [
  "headH", "headV",          // head direction relative to the face→camera line (°), tracker's sign convention
  "noseX", "noseY",          // nose within the face outline (geometric), used to fix head sign conventions
  "bHL", "bHR", "bVL", "bVR", // model gaze blendshapes per eye (unitless); NaN while that eye blinks
  "iHL", "iHR", "iVL", "iVR", // iris centre along/across the eye-corner line (eye widths); NaN while blinking
  "blinkL", "blinkR",        // blink blendshape scores 0..1
  "openL", "openR",          // lid gap / eye width
  "jaw",                     // jawOpen blendshape 0..1 (mouth movement, for telling speaking from quiet)
  "why",                     // 0 = face used; 1 = no face found; 2 = face found but eyes out of frame
  "gain",                    // brightening applied to the frame before tracking (1 = none)
  "dist",                    // face-to-camera distance from the head-pose model (relative units; only ratios are used)
] as const;
export type Field = (typeof FIELDS)[number];

export const FP_W = 16, FP_H = 12, FP_SIZE = FP_W * FP_H;

export interface Run {
  id: string;
  recId: string;
  /** Interval this run covers (ms). Frames lie in [start, end). */
  start: number;
  end: number;
  /** Times estimated from a screen capture without confirmed alignment. */
  approx: boolean;
  t: Float64Array;
  /** 1 = face tracked in this frame. */
  valid: Uint8Array;
  cols: Record<Field, Float32Array>;
  /** FP_SIZE bytes per frame, normalised greyscale. */
  fp: Uint8Array;
  createdAt: number;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  label: string;
  note: string;
  /** From a screen capture whose timing could not be confirmed against earlier data. */
  approx?: boolean;
  createdAt: number;
}

export interface Region {
  id: string;
  name: string;
  colour: string;
  isScreen: boolean;
  /** Rectangle in display coordinates: h positive = towards the person's left (image right), v positive = up. Degrees. */
  h0: number; h1: number; v0: number; v1: number;
  /** Placed automatically from the on-screen cluster; refitted as more is analysed until the reviewer edits it. */
  auto?: boolean;
}

export interface RecordingSettings {
  eyeSource: "blend" | "iris";
  /** Degrees of gaze per unit of eye measure; null = fit automatically. */
  kH: number | null;
  kV: number | null;
  /** Window for following slow posture drift (s); 0 = off. */
  driftWindowS: number;
  /** Shortest excursion listed as an event, in frames. */
  minFrames: number;
  /** Eye value is held through blinks up to this long (ms). */
  blinkHoldMs: number;
  /** Replace the eye movement during blinks with a straight line from before to after. */
  blinkFilter: boolean;
  /** Lids below this percentage of the person's usual opening count as closing. */
  blinkLidPct: number;
  /** Lid dips longer than this (ms) are kept: they are looks down, not blinks. */
  blinkMaxMs: number;
  /** Rescale gaze angles to the person's usual distance from the camera. */
  distanceCorrection: boolean;
  /** Looks shorter than this (ms) are left out of the event-timeline analysis. */
  minLookMs: number;
  /** Looks with fewer frames than this inside the chosen region are left out (0 = any). */
  minRegionFrames: number;
  /**
   * How looks are formed for the event-timeline analysis. "standard": runs of frames away from the
   * screen region(s). "stretches": the way the first exported figures counted, with every region
   * treated as an ordinary region, so a look is a long stretch credited to the region it spends
   * most frames in; brief crossings into a region don't count.
   */
  lookMode: "standard" | "stretches";
  /** The "just before" window for the event test (ms). */
  beforeWindowMs: number;
  /** Count each look only for the item being answered (since the previous save), and compare with chance only within the timeline's span. */
  countOnce: boolean;
  /** Noise gate for speech: threshold in dB (null = 12 dB above the quiet background), bridging and minimum length (ms). */
  gateDb: number | null;
  gateHoldMs: number;
  gateMinMs: number;
  /** An eye counts as closed (its value unused) when its blink score is above eyeBlinkMax or its lid gap is below eyeOpenMin × eye width. */
  eyeBlinkMax: number;
  eyeOpenMin: number;
  /** Sequence figure: how far before and after the anchor to show (ms). */
  seqBeforeMs: number;
  seqAfterMs: number;
}

export const DEFAULT_SETTINGS: RecordingSettings = {
  eyeSource: "blend",
  kH: null,
  kV: null,
  driftWindowS: 60,
  minFrames: 2,
  blinkHoldMs: 300,
  blinkFilter: true,
  blinkLidPct: 70,
  blinkMaxMs: 400,
  distanceCorrection: true,
  minLookMs: 0,
  minRegionFrames: 0,
  lookMode: "standard",
  beforeWindowMs: 10_000,
  countOnce: true,
  gateDb: null,
  gateHoldMs: 400,
  gateMinMs: 250,
  eyeBlinkMax: 0.5,
  eyeOpenMin: 0.12,
  seqBeforeMs: 30_000,
  seqAfterMs: 15_000,
};

/** A mark made by the reviewer while watching. Submit marks are instants (end = start). */
export type AnnotationKind = "look" | "obscured" | "speech" | "submit";
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  start: number;
  end: number;
  note: string;
  origin: "manual";
  createdAt: number;
}

/** How video time relates to the clock times of an event timeline. */
export interface SyncInfo {
  /** Wall-clock time at the start of the video (YYYY-MM-DDTHH:mm:ss, no zone), or null if not set. */
  startClock: string | null;
  /** How it was set, e.g. "typed", "lined up with an event", "file date". */
  method: string;
  note: string;
}

/** A second video shown in its own window, kept in step with the main one. */
export interface LinkedVideo {
  fileName: string;
  fileSize: number;
  /** How much later than the main video it started (ms); its time = main time − offset. */
  offsetMs: number;
  offsetSource: string;
}

export interface Recording {
  id: string;
  name: string;
  kind: "file" | "capture";
  fileName?: string;
  fileSize?: number;
  durationMs: number;
  width: number;
  height: number;
  frameIntervalMs: number;
  segments: Segment[];
  regions: Region[];
  settings: RecordingSettings;
  /** Imported event timeline (e.g. saved responses), kept verbatim. */
  timeline?: import("../timeline/eventTimeline").StoredTimeline;
  sync?: SyncInfo;
  linked?: LinkedVideo[];
  /** The video file's own date header (ms UTC), if it had one. */
  fileDateUtcMs?: number;
  /** Reviewer's marks: phone looks, eyes obscured, speech, submits seen. */
  annotations?: Annotation[];
  /** Labels placed on the gaze trace at chosen moments (video ms). */
  traceLabels?: { id: string; t: number }[];
  /** Sound level in 20 ms bins (dB), from the audio track; the audio itself is never kept. */
  audioEnv?: { binMs: number; db: Float32Array };
  createdAt: number;
  updatedAt: number;
}

export function newId(prefix: string): string {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return prefix + "-" + Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
}
