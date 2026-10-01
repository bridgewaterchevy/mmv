/**
 * Pick-level aggregates over its photos (see shared/schema.ts `picks` comment).
 *
 * Pure functions: used by storage.recomputePickAggregates (persisted on the picks row) and by storage.pickView
 * (computed fresh from the photo rows so the API never shows a stale aggregate).
 */
import type { AnalysisStatus, GarmentItem, PickPhoto } from "@shared/schema";
import { PICK_MAX_ITEMS, PICK_MAX_PALETTE } from "@shared/schema";

export interface PickAggregate {
  items: GarmentItem[];
  palette: string[];
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  analyzedAt: Date | null;
  /** One-line summary of the first ready photo (cover first); PickView.note falls back to it. */
  summary: string | null;
  /** Path of the cover (position 0) photo, or null when the pick has no photos. */
  coverPath: string | null;
}

export function aggregatePhotos(photosIn: PickPhoto[]): PickAggregate {
  const photos = [...photosIn].sort((a, b) => a.position - b.position || a.id - b.id);
  const statuses = photos.map((p) => p.analysisStatus);
  const analysisStatus: AnalysisStatus = statuses.includes("pending") ? "pending" : statuses.includes("ready") ? "ready" : "failed";
  const anyReady = statuses.includes("ready");
  const firstFailed = photos.find((p) => p.analysisStatus === "failed");
  const analyzedDates = photos.map((p) => p.analyzedAt).filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  const analyzedAt = analyzedDates.length ? new Date(Math.max(...analyzedDates.map((d) => d.getTime()))) : null;
  const summary = photos.find((p) => p.analysisStatus === "ready" && p.summary && p.summary.trim())?.summary?.trim() ?? null;
  return {
    items: mergeItems(photos.flatMap((p) => (Array.isArray(p.items) ? p.items : []))),
    palette: mergePalette(photos.flatMap((p) => (Array.isArray(p.palette) ? p.palette : []))),
    analysisStatus,
    analysisError: !anyReady && firstFailed ? firstFailed.analysisError ?? "Analysis failed" : null,
    analyzedAt,
    summary,
    coverPath: photos[0]?.path ?? null,
  };
}

/** Distinct hexes (case-insensitive), first occurrence wins, capped. */
export function mergePalette(hexes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hexes) {
    if (typeof h !== "string" || !/^#[0-9a-f]{6}$/i.test(h)) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= PICK_MAX_PALETTE) break;
  }
  return out;
}

/**
 * Concatenate in photo order and drop near-duplicates: same (normalised) category AND either a close colour
 * (RGB distance) or a very similar searchQuery (token overlap). A duplicate found later only contributes a
 * brandGuess when the kept item has none. Capped at PICK_MAX_ITEMS.
 */
export function mergeItems(items: GarmentItem[]): GarmentItem[] {
  const out: GarmentItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const dup = out.find((kept) => isNearDuplicate(kept, raw));
    if (dup) {
      if (!dup.brandGuess && raw.brandGuess) dup.brandGuess = raw.brandGuess;
      continue;
    }
    out.push({ ...raw });
    if (out.length >= PICK_MAX_ITEMS) break;
  }
  return out;
}

export function isNearDuplicate(a: GarmentItem, b: GarmentItem): boolean {
  if (normCategory(a.category) !== normCategory(b.category)) return false;
  const colorClose = colorDistance(a.colorHex, b.colorHex) <= COLOR_CLOSE || (normWord(a.colorName) !== "" && normWord(a.colorName) === normWord(b.colorName));
  if (colorClose) return true;
  return querySimilarity(a.searchQuery, b.searchQuery) >= QUERY_SIMILAR;
}

/** Perceptual-ish RGB distance (0..441). ~60 ≈ shades of the same colour under different light. */
const COLOR_CLOSE = 60;
/** Jaccard over query tokens; 0.6 keeps "black leggings" vs "black high rise leggings" together but not "black tee" vs "white tee". */
const QUERY_SIMILAR = 0.6;

function normCategory(c: string | undefined): string {
  let s = (c ?? "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  // light singularisation so "shoes"/"shoe", "leggings"/"legging", "sneakers"/"sneaker" match (same rule on both sides)
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  const alias: Record<string, string> = { sneaker: "shoe", trainer: "shoe", runner: "shoe", "running shoe": "shoe", tee: "t shirt", tshirt: "t shirt", tight: "legging" };
  return alias[s] ?? s;
}
function normWord(w: string | undefined): string {
  return (w ?? "").toLowerCase().replace(/[^a-z]/g, "");
}
function colorDistance(h1: string | undefined, h2: string | undefined): number {
  const a = hexToRgb(h1);
  const b = hexToRgb(h2);
  if (!a || !b) return Infinity;
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}
function hexToRgb(h: string | undefined): [number, number, number] | null {
  if (!h || !/^#[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
const STOP = new Set(["the", "a", "an", "and", "with", "for", "of", "in", "womens", "mens", "women", "men", "unisex"]);
function tokens(q: string | undefined): Set<string> {
  return new Set(
    (q ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOP.has(t)),
  );
}
export function querySimilarity(q1: string | undefined, q2: string | undefined): number {
  const a = tokens(q1);
  const b = tokens(q2);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((t) => {
    if (b.has(t)) inter++;
  });
  return inter / (a.size + b.size - inter);
}
