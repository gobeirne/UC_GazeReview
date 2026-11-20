import { FIELDS, type Field, type Recording, type Run } from "./types";

const DB_NAME = "uc-gaze-review";
const VERSION = 2;

let dbp: Promise<IDBDatabase> | null = null;
/** Set by the app to show storage messages. */
export let onDbBlocked: ((message: string) => void) | null = null;
export function setDbMessageHandler(f: (message: string) => void) { onDbBlocked = f; }
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" });
      if (!d.objectStoreNames.contains("runs")) d.createObjectStore("runs", { keyPath: "id" }).createIndex("recId", "recId");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const d = req.result;
      // Let a newer version of the app in another window upgrade the database.
      d.onversionchange = () => { d.close(); dbp = null; onDbBlocked?.("This tool was updated in another window. Reload this window to keep working."); };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    // An older version open in another window is holding the database.
    req.onblocked = () => onDbBlocked?.("Close any other windows of this tool (they’re running an older version) so saved work can be updated.");
  });
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

export async function listRecordings(): Promise<Recording[]> {
  const d = await db();
  const all = await wrap(d.transaction("recordings").objectStore("recordings").getAll()) as Recording[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  const d = await db();
  return await wrap(d.transaction("recordings").objectStore("recordings").get(id)) as Recording | undefined;
}

export async function putRecording(r: Recording): Promise<void> {
  const d = await db();
  r.updatedAt = Date.now();
  const tx = d.transaction("recordings", "readwrite");
  tx.objectStore("recordings").put(r);
  await done(tx);
}

export async function getRuns(recId: string): Promise<Run[]> {
  const d = await db();
  const runs = await wrap(d.transaction("runs").objectStore("runs").index("recId").getAll(recId)) as Run[];
  for (const r of runs) for (const k of FIELDS) r.cols[k] ??= new Float32Array(r.t.length).fill(NaN);
  return runs.sort((a, b) => a.start - b.start);
}

export async function putRuns(runs: Run[]): Promise<void> {
  if (!runs.length) return;
  const d = await db();
  const tx = d.transaction("runs", "readwrite");
  for (const r of runs) tx.objectStore("runs").put(r);
  await done(tx);
}

export async function deleteRuns(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const d = await db();
  const tx = d.transaction("runs", "readwrite");
  for (const id of ids) tx.objectStore("runs").delete(id);
  await done(tx);
}

export async function deleteRecording(id: string): Promise<void> {
  const runs = await getRuns(id);
  await deleteRuns(runs.map((r) => r.id));
  const d = await db();
  const tx = d.transaction("recordings", "readwrite");
  tx.objectStore("recordings").delete(id);
  await done(tx);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return await wrap(d.transaction("meta").objectStore("meta").get(key)) as T | undefined;
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const d = await db();
  const tx = d.transaction("meta", "readwrite");
  if (value === undefined) tx.objectStore("meta").delete(key); else tx.objectStore("meta").put(value, key);
  await done(tx);
}

/** Asks the browser not to evict this site's storage under pressure. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

// ---- Export / import: one JSON file per recording, no video ----

const FORMAT = "uc-gaze-review";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/**
 * thumbnails: include the 16×12 frame thumbnails. They are only used to line up later
 * screen captures with this analysis; leaving them out makes the file smaller and keeps
 * no image-derived data in it.
 */
export function exportJson(rec: Recording, runs: Run[], opts: { thumbnails: boolean; timelineText?: boolean } = { thumbnails: true }): string {
  let recording: Recording = opts.timelineText === false && rec.timeline
    ? { ...rec, timeline: { ...rec.timeline, data: { ...rec.timeline.data, events: rec.timeline.data.events.map(({ question_text: _q, ...e }) => ({ ...e, answer: "" })) } } }
    : rec;
  if (recording.audioEnv) recording = { ...recording, audioEnv: { binMs: recording.audioEnv.binMs, db: b64(bytesOf(recording.audioEnv.db)) as unknown as Float32Array } };
  return JSON.stringify({
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    thumbnails: opts.thumbnails,
    timelineText: opts.timelineText !== false,
    recording,
    runs: runs.map((r) => {
      const { fp, ...rest } = r;
      return {
        ...rest,
        t: b64(bytesOf(r.t)),
        valid: b64(r.valid),
        ...(opts.thumbnails && fp.length ? { fp: b64(fp) } : {}),
        cols: Object.fromEntries(FIELDS.map((k) => [k, b64(bytesOf(r.cols[k]))])),
      };
    }),
  });
}

export function importJson(text: string): { recording: Recording; runs: Run[] } {
  const o = JSON.parse(text);
  if (o?.format !== FORMAT) throw new Error("This is not a gaze review export file.");
  if (o.version !== 1) throw new Error(`Unsupported export version ${o.version}.`);
  const f32 = (s: string) => { const b = unb64(s); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const f64 = (s: string) => { const b = unb64(s); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const runs: Run[] = o.runs.map((r: Record<string, unknown>) => {
    const t = f64(r.t as string);
    const cols = r.cols as Partial<Record<Field, string>>;
    return {
      ...r,
      t,
      valid: unb64(r.valid as string),
      fp: typeof r.fp === "string" ? unb64(r.fp) : new Uint8Array(0), // exported without thumbnails
      // Fields added after a file was exported come back as "not measured".
      cols: Object.fromEntries(FIELDS.map((k) => [k, typeof cols[k] === "string" ? f32(cols[k]!) : new Float32Array(t.length).fill(NaN)])),
    };
  });
  const recording = o.recording as Recording;
  if (recording.audioEnv && typeof recording.audioEnv.db === "string") recording.audioEnv = { binMs: recording.audioEnv.binMs, db: f32(recording.audioEnv.db as unknown as string) };
  return { recording, runs };
}
