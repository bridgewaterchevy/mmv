/**
 * Client-side photo downscale before upload.
 *
 * Phones hand us 12 MP HEIC/JPEG files (3–8 MB). The server only needs ~1280px for palette +
 * garment analysis, so we decode in the browser, draw to a canvas with the long edge capped,
 * and export a JPEG. That cuts upload time 5–10× on cellular and keeps the UI "instant".
 *
 * Orientation: `createImageBitmap(file, { imageOrientation: "from-image" })` applies EXIF
 * rotation at decode time (Chrome 81+, Safari 15+, Firefox 105+). Browsers that reject the
 * option fall back to a plain bitmap, then to an <img> element — which modern engines also
 * orient via the default `image-orientation: from-image` CSS behaviour.
 *
 * HEIC: Chrome/Firefox can't decode it, so every decode path throws and we return the original
 * File untouched; the server sniffs the bytes and converts (or 400s with a friendly message).
 */

export const UPLOAD_MAX_EDGE = 1280;
export const UPLOAD_JPEG_QUALITY = 0.82;
export const UPLOAD_FILE_NAME = "photo.jpg";

export interface DownscaleOptions {
  maxEdge?: number;
  quality?: number;
  /** Re-encode even when the source already fits within maxEdge and is a JPEG. */
  force?: boolean;
}

export interface DownscaleResult {
  file: File;
  /** false when the original File was returned unchanged (decode failed or no gain). */
  changed: boolean;
  width?: number;
  height?: number;
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

async function decodeWithBitmap(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    try {
      bmp = await createImageBitmap(file);
    } catch {
      return null;
    }
  }
  if (!bmp) return null;
  const b = bmp;
  return { source: b, width: b.width, height: b.height, release: () => b.close?.() };
}

function decodeWithImg(file: Blob): Promise<Decoded | null> {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (v: Decoded | null) => {
      if (!v) URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return done(null);
      done({ source: img, width: w, height: h, release: () => URL.revokeObjectURL(url) });
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

async function decode(file: Blob): Promise<Decoded | null> {
  return (await decodeWithBitmap(file)) ?? (await decodeWithImg(file));
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Downscale `file` so its long edge is ≤ `maxEdge` and return a JPEG File named photo.jpg.
 * Falls back to the original File when decoding fails (HEIC on non-Safari, corrupt bytes) or
 * when re-encoding wouldn't shrink anything.
 */
export async function downscaleForUpload(file: File, opts: DownscaleOptions = {}): Promise<DownscaleResult> {
  const maxEdge = opts.maxEdge ?? UPLOAD_MAX_EDGE;
  const quality = opts.quality ?? UPLOAD_JPEG_QUALITY;
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const tag = `[image] ${file.name || "photo"} (${file.type || "unknown"}, ${kb(file.size)})`;

  const decoded = await decode(file);
  if (!decoded) {
    console.debug(`${tag}: could not decode in-browser, sending original unchanged`);
    return { file, changed: false };
  }

  try {
    const { width: w, height: h } = decoded;
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    const isJpeg = /jpe?g$/i.test(file.type);
    if (scale === 1 && isJpeg && !opts.force) {
      console.debug(`${tag}: ${w}x${h} already within ${maxEdge}px, sending original unchanged`);
      return { file, changed: false, width: w, height: h };
    }
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    if (typeof document === "undefined") return { file, changed: false, width: w, height: h };
    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { file, changed: false, width: w, height: h };
    // JPEG has no alpha; paint white so transparent PNG screenshots don't go black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, nw, nh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, nw, nh);
    const blob = await canvasToJpeg(canvas, quality);
    if (!blob) {
      console.debug(`${tag}: canvas export failed, sending original unchanged`);
      return { file, changed: false, width: w, height: h };
    }
    // A small, already-efficient JPEG can grow after re-encoding; don't ship a bigger file for nothing.
    if (scale === 1 && isJpeg && blob.size >= file.size) {
      console.debug(`${tag}: re-encode would grow ${kb(file.size)} → ${kb(blob.size)}, sending original unchanged`);
      return { file, changed: false, width: w, height: h };
    }
    const out = new File([blob], UPLOAD_FILE_NAME, { type: "image/jpeg", lastModified: Date.now() });
    const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);
    console.debug(`${tag}: ${w}x${h} → ${nw}x${nh}, ${kb(file.size)} → ${kb(out.size)} (${Math.round((1 - out.size / file.size) * 100)}% smaller, ${ms} ms)`);
    return { file: out, changed: true, width: nw, height: nh };
  } finally {
    decoded.release();
  }
}
