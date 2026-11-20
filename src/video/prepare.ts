import type { RawFace } from "../tracking/FeatureExtractor";

/**
 * Prepares each frame for the face tracker:
 *
 * - Padding. The face detector misses faces that run off the edge of the picture (a chin
 *   cut off by a low laptop camera, a head near the top). Each frame is drawn onto a
 *   canvas with a neutral grey border of PAD on every side, so the face never touches
 *   the edge of what the detector sees. Landmarks are mapped back to the original frame,
 *   and the head-pose translation is rescaled (the pose model assumes a fixed field of
 *   view across whatever image it is given, so padding shrinks the angles to the face by
 *   the padding factor).
 * - Brightening. In dim frames (mean luminance below DIM of 255) the frame is brightened
 *   towards a mean of TARGET, up to MAX_GAIN, with a little extra contrast.
 */
const PAD = 0.15;
const DIM = 95, TARGET = 120, MAX_GAIN = 2.2;

export class FramePrep {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private w = 0; private h = 0; private px = 0; private py = 0;
  /** Brightness gain used on the last frame (1 = unchanged). */
  gain = 1;

  /** meanLuma: mean grey level of the frame (0–255), e.g. from its 64×48 thumbnail. */
  draw(src: CanvasImageSource, w: number, h: number, meanLuma: number, crop?: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
    const px = Math.round(w * PAD), py = Math.round(h * PAD);
    const W = w + 2 * px, H = h + 2 * py;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.w = w; this.h = h; this.px = px; this.py = py;
    const c = this.ctx;
    c.filter = "none";
    c.fillStyle = "#808080";
    c.fillRect(0, 0, W, H);
    this.gain = meanLuma > 0 && meanLuma < DIM ? Math.min(MAX_GAIN, TARGET / meanLuma) : 1;
    if (this.gain > 1.05) c.filter = `brightness(${this.gain.toFixed(2)}) contrast(1.15)`;
    if (crop) c.drawImage(src, crop.x, crop.y, crop.w, crop.h, px, py, w, h);
    else c.drawImage(src, px, py, w, h);
    c.filter = "none";
    return this.canvas;
  }

  /** Maps a tracker result on the padded canvas back to the original frame. */
  unmap(raw: RawFace | undefined): RawFace | undefined {
    if (!raw) return raw;
    const W = this.canvas.width, H = this.canvas.height;
    const landmarks = raw.landmarks.map((p) => ({ ...p, x: (p.x * W - this.px) / this.w, y: (p.y * H - this.py) / this.h }));
    let transform = raw.transform;
    if (transform && transform.length === 16) {
      const k = H / this.h; // = W / w: padding is the same fraction on every side
      transform = transform.slice();
      transform[12] *= k; // column-major: translation is the 4th column
      transform[13] *= k;
    }
    return { ...raw, landmarks, imageWidth: this.w, imageHeight: this.h, transform };
  }
}

/** Mean of a greyscale buffer. */
export function meanOf(g: Uint8Array): number {
  let s = 0; for (const x of g) s += x; return g.length ? s / g.length : 0;
}
