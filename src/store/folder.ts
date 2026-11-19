/**
 * Saving analysis files into a folder the reviewer chooses (File System Access API:
 * Chrome and Edge). Each recording is kept as "<video name>.gaze.json" in that folder,
 * the same format as Export, and read back when the video is opened again. Browsers
 * only allow this for a folder the reviewer has picked, and ask again for permission in
 * each new session; the folder choice itself is remembered.
 */
import { getMeta, putMeta } from "./db";

type Perm = "granted" | "denied" | "prompt";
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(o: { mode: "readwrite" }): Promise<Perm>;
  requestPermission(o: { mode: "readwrite" }): Promise<Perm>;
  values(): AsyncIterable<FileSystemHandle>;
}

export const folderSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

let dir: DirHandle | null = null;
let ready = false;

export function folderName(): string | null { return dir?.name ?? null; }
export function folderReady(): boolean { return ready; }

/** Restores the remembered folder; true if it can be used without asking. */
export async function restoreFolder(): Promise<boolean> {
  if (!folderSupported) return false;
  dir = (await getMeta<DirHandle>("folder")) ?? null;
  ready = !!dir && (await dir.queryPermission({ mode: "readwrite" })) === "granted";
  return ready;
}

/** Asks again for the remembered folder (must be called from a click). */
export async function reconnectFolder(): Promise<boolean> {
  if (!dir) return false;
  ready = (await dir.requestPermission({ mode: "readwrite" })) === "granted";
  return ready;
}

export async function chooseFolder(): Promise<boolean> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  dir = await picker({ mode: "readwrite", id: "gaze-review" });
  await putMeta("folder", dir);
  ready = (await dir.queryPermission({ mode: "readwrite" })) === "granted" || (await dir.requestPermission({ mode: "readwrite" })) === "granted";
  return ready;
}

export async function forgetFolder() { dir = null; ready = false; await putMeta("folder", undefined); }

/** "exam 12.webm" → "exam 12.gaze.json". */
export function sidecarName(videoOrRecordingName: string): string {
  return videoOrRecordingName.replace(/\.(webm|mkv|mp4|mov)$/i, "").replace(/[\\/:*?"<>|]+/g, "_") + ".gaze.json";
}

export async function readSidecar(name: string): Promise<string | null> {
  if (!dir || !ready) return null;
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch { return null; }
}

export async function writeSidecar(name: string, text: string): Promise<void> {
  if (!dir || !ready) return;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

export interface FolderVideo { name: string; handle: FileSystemFileHandle; analysed: boolean }

export async function listVideos(): Promise<FolderVideo[]> {
  if (!dir || !ready) return [];
  const names = new Set<string>();
  const vids: { name: string; handle: FileSystemFileHandle }[] = [];
  for await (const h of dir.values()) {
    names.add(h.name);
    if (h.kind === "file" && /\.(webm|mkv)$/i.test(h.name)) vids.push({ name: h.name, handle: h as FileSystemFileHandle });
  }
  return vids.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((v) => ({ ...v, analysed: names.has(sidecarName(v.name)) }));
}
