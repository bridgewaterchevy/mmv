/**
 * Background outfit analysis, one job per PHOTO.
 *
 * POST /api/sessions/:id/picks (1..N photos) and POST /api/picks/:id/photos store the files and answer immediately
 * with analysisStatus "pending"; the Gemini calls (20-40 s each on a cold free tier) run here afterwards. A small
 * in-process queue keeps at most VISION_CONCURRENCY (default 2) Gemini requests in flight so a burst of uploads
 * does not hammer the API, and jobs are deduped per photo id.
 *
 * Correctness notes
 *  - Every job carries the `photoPath` it was started for and storage.completePhotoAnalysis/failPhotoAnalysis only
 *    write when the pick_photos row still has that path, so a slow analysis can never land on a replaced photo.
 *    (Re-posting a pick deletes its photo rows, so stale jobs simply find no row.)
 *  - Finishing a photo recomputes the pick aggregates (items/palette/status) in the same transaction.
 *  - If a job for a photo is already running when another is requested, the new request is parked and started once
 *    the running one finishes (it reloads the row, so it sees the current state).
 *  - The queue is in-memory: a restart loses it. recoverStuckAnalyses() re-queues photo rows still "pending" after
 *    START_RECOVERY_AGE_MS at boot, and a periodic sweep catches anything else that slipped through.
 *  - Errors stored on the row are short and scrubbed (no URLs with query strings, no key/token-looking text).
 */
import { storage } from "./storage";
import { files } from "./files";
import { analyzeOutfit } from "./vision";
import type { PickPhoto } from "@shared/schema";

export interface AnalysisJob {
  /** pick_photos.id — the queue key. */
  photoId: number;
  pickId: number;
  /** Photo path the job was created for; results are dropped if the row has moved on. */
  photoPath: string;
  /** Upload bytes when we still have them (fresh upload); otherwise the photo is loaded from the file store. */
  buffer?: Buffer;
  mime?: string;
  /** Why this job exists (logging only). */
  reason: "upload" | "retry" | "recovery" | "sweep";
}

const CONCURRENCY = Math.max(1, Number(process.env.VISION_CONCURRENCY || 2) || 2);
/** Hard cap on one Gemini round-trip (the client stops polling at ~90 s). */
const JOB_TIMEOUT_MS = Math.max(10_000, Number(process.env.VISION_TIMEOUT_MS || 120_000) || 120_000);
/** Boot recovery: pending photos created before this long ago are re-queued. */
export const START_RECOVERY_AGE_MS = Math.max(0, Number(process.env.VISION_RECOVERY_AGE_MS ?? 2 * 60 * 1000) || 0);
/** Periodic sweep for pending photos nobody is working on (safety net; cheap indexed query). */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_AGE_MS = 10 * 60 * 1000;

const queued = new Map<number, AnalysisJob>(); // waiting, in insertion order (key: photo id)
const running = new Set<number>();
const parked = new Map<number, AnalysisJob>(); // requested while the same photo was running
let stats = { started: 0, ready: 0, failed: 0, dropped: 0 };

export function enqueueAnalysis(job: AnalysisJob): void {
  if (running.has(job.photoId)) {
    parked.set(job.photoId, job);
    return;
  }
  // Dedupe: a newer request for the same photo replaces the waiting one (it would reload the row anyway).
  queued.set(job.photoId, job);
  pump();
}

export function isAnalysisQueued(photoId: number): boolean {
  return queued.has(photoId) || running.has(photoId) || parked.has(photoId);
}

/** For logs/tests. */
export function analysisQueueStats() {
  return { ...stats, queued: queued.size, running: running.size, parked: parked.size, concurrency: CONCURRENCY };
}

function pump() {
  while (running.size < CONCURRENCY && queued.size > 0) {
    const [photoId, job] = queued.entries().next().value as [number, AnalysisJob];
    queued.delete(photoId);
    running.add(photoId);
    stats.started++;
    void runJob(job)
      .catch((err) => console.error(`[analysis] photo ${photoId} job crashed`, err))
      .finally(() => {
        running.delete(photoId);
        const next = parked.get(photoId);
        if (next) {
          parked.delete(photoId);
          queued.set(photoId, next);
        }
        pump();
      });
  }
}

async function runJob(job: AnalysisJob): Promise<void> {
  const t0 = Date.now();
  const photo = await storage.getPhoto(job.photoId);
  const tag = `pick ${job.pickId} photo ${job.photoId}`;
  if (!photo) {
    stats.dropped++;
    return; // deleted meanwhile (photo removed or pick re-posted)
  }
  if (photo.path !== job.photoPath) {
    stats.dropped++;
    console.log(`[analysis] ${tag}: path changed before analysis started; skipping stale job (${job.reason})`);
    return;
  }
  if (photo.analysisStatus !== "pending") {
    // Someone (another instance?) already finished it. Only the explicit retry path re-marks pending first.
    stats.dropped++;
    return;
  }
  try {
    let buffer = job.buffer;
    let mime = job.mime;
    if (!buffer) {
      const loaded = await files.read(photo.path);
      buffer = loaded.buffer;
      mime = loaded.mime;
    }
    buffer = await downscaleForVision(buffer);
    const analysis = await withTimeout(analyzeOutfit(buffer, mime || "image/jpeg"), JOB_TIMEOUT_MS, "Analysis timed out");
    const updated = await storage.completePhotoAnalysis(photo.id, photo.path, {
      palette: analysis.palette,
      items: analysis.items,
      summary: analysis.summary || null,
    });
    if (updated) stats.ready++;
    else stats.dropped++;
    console.log(
      `[analysis] ${tag} ${updated ? "ready" : "stale (photo replaced)"}: ${analysis.items.length} item(s) in ${Date.now() - t0}ms (${job.reason})`,
    );
  } catch (err) {
    const short = shortError(err);
    const updated = await storage.failPhotoAnalysis(photo.id, photo.path, short).catch((e: unknown) => {
      console.error(`[analysis] ${tag}: could not record failure`, e);
      return undefined;
    });
    if (updated) stats.failed++;
    else stats.dropped++;
    console.error(`[analysis] ${tag} failed after ${Date.now() - t0}ms (${job.reason}): ${short}`);
  }
}

/**
 * Optional server-side downscale before Gemini. `sharp` is NOT a dependency of this project (and is a heavy
 * native module), so this is a no-op unless it happens to be installed; the client already resizes to
 * ~1280 px before uploading. If sharp is present we cap the long edge at 1280 px and re-encode as JPEG.
 */
let sharpLoader: Promise<((input: Buffer) => { rotate(): any }) | null> | null = null;
async function downscaleForVision(buffer: Buffer): Promise<Buffer> {
  if (process.env.VISION_DOWNSCALE === "0") return buffer;
  if (!sharpLoader) {
    sharpLoader = (async () => {
      try {
        const name = "sharp"; // variable so neither tsc nor esbuild tries to resolve the optional module
        const mod = (await import(name)) as unknown as { default?: unknown };
        const fn = (mod.default ?? mod) as (input: Buffer) => { rotate(): any };
        return typeof fn === "function" ? fn : null;
      } catch {
        return null; // not installed: expected
      }
    })();
  }
  const sharp = await sharpLoader;
  if (!sharp) return buffer;
  try {
    const out: Buffer = await sharp(buffer).rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return out.length < buffer.length ? out : buffer;
  } catch {
    return buffer; // HEIC without codec etc.: send the original
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Short, user-safe error text: no query strings, nothing that looks like a key/token, 200 chars max.
 * Gemini HTTP errors ("Gemini <model> <status>: {json}") are condensed to "Gemini <status>: <message>".
 */
export function shortError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
  const gemini = /^Gemini\s+(\S+)\s+(\d{3}):\s*([\s\S]*)$/.exec(msg);
  if (gemini) {
    const [, , status, rest] = gemini;
    const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(rest); // closing quote optional: vision.ts truncates bodies
    const detail = (inner?.[1] ?? rest).replace(/\\"/g, '"').trim();
    msg = `Gemini ${status}: ${detail || "request failed"}`;
  }
  msg = msg
    .replace(/https?:\/\/[^\s"']+/g, (u) => u.split("?")[0]) // drop query strings from any URL
    .replace(/(key|token|secret|authorization|api[-_]?key)\s*[=:]\s*[^\s&"',}]+/gi, "$1=[redacted]")
    .replace(/\b(AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,}|gh[pousr]_[0-9A-Za-z]{16,}|github_pat_[0-9A-Za-z_]{16,})\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!msg) msg = "Unknown error";
  return msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
}

/**
 * Boot recovery: photos still "pending" after START_RECOVERY_AGE_MS have no job in this (fresh) process, so
 * re-queue them. Returns the count (also logged). Call once routes are registered and the file store is ready.
 */
export async function recoverStuckAnalyses(ageMs = START_RECOVERY_AGE_MS, reason: AnalysisJob["reason"] = "recovery"): Promise<number> {
  const rows: PickPhoto[] = await storage.stalePendingPhotos(new Date(Date.now() - ageMs));
  let n = 0;
  for (const ph of rows) {
    if (isAnalysisQueued(ph.id)) continue;
    enqueueAnalysis({ photoId: ph.id, pickId: ph.pickId, photoPath: ph.path, reason });
    n++;
  }
  if (reason === "recovery" || n > 0) console.log(`[analysis] ${reason}: re-queued ${n} pending photo(s) older than ${Math.round(ageMs / 1000)}s`);
  return n;
}

let sweepTimer: NodeJS.Timeout | null = null;
/** Periodic safety net (every 10 min) for pending rows nobody is working on. Idempotent. */
export function startAnalysisSweeper(): void {
  if (sweepTimer || process.env.VISION_SWEEP === "0") return;
  sweepTimer = setInterval(() => {
    recoverStuckAnalyses(SWEEP_AGE_MS, "sweep").catch((err) => console.error("[analysis] sweep failed", err));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
