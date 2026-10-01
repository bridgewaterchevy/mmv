import type { PickView } from "@shared/schema";

/**
 * Async outfit analysis state, mirrored from the server contract:
 *   POST /api/sessions/:id/picks → 201 PickView { analysisStatus: "pending", items: [], palette: [] }
 *   GET  /api/picks/:id          → PickView; "ready" fills items/palette, "failed" sets analysisError
 *   POST /api/picks/:id/analyze  → re-queues (owner only)
 * Picks created before the field existed have no analysisStatus and are treated as "ready".
 *
 * Multi-photo picks (up to MAX_PICK_PHOTOS per pick):
 *   PickView.photos: [{ id, url, position, analysisStatus, analysisError, itemCount }]
 *   POST   /api/picks/:id/photos                   (multipart `photo`, 1–N) → 201 PickView
 *   DELETE /api/picks/:id/photos/:photoId          → 200 PickView (400 when it's the last photo)
 *   POST   /api/picks/:id/photos/:photoId/analyze  → re-queue a single photo
 * Pick-level items/palette/analysisStatus are aggregates across photos. Picks without `photos`
 * (older rows, or a server that predates the field) are treated as a single photo built from photoPath.
 */
export type AnalysisStatus = "pending" | "ready" | "failed";

export const MAX_PICK_PHOTOS = 6;

/**
 * One photo of a pick. Mirrors shared PickPhotoView but keeps every analysis field optional so a
 * server that predates per-photo analysis still type-checks; `synthetic`/`optimistic` are client-only.
 */
export interface PickPhotoView {
  id: number;
  url: string;
  position: number;
  analysisStatus?: AnalysisStatus;
  analysisError?: string | null;
  itemCount?: number;
  /** Client-only: true for the stand-in built from `photoPath` when the server sent no `photos`. */
  synthetic?: boolean;
  /** Client-only: true while an optimistic upload is in flight (url is an object URL). */
  optimistic?: boolean;
}

export type PickWithAnalysis = Omit<PickView, "analysisStatus" | "analysisError" | "photos" | "analysisFailed"> & {
  analysisStatus?: AnalysisStatus;
  analysisError?: string | null;
  analysisFailed?: boolean;
  /** Absent on legacy picks / older servers: treat as one photo built from `photoPath` (see photosOf). */
  photos?: PickPhotoView[];
};

export function analysisStatusOf(p: Pick<PickWithAnalysis, "analysisStatus"> | null | undefined): AnalysisStatus {
  const s = p?.analysisStatus;
  return s === "pending" || s === "failed" ? s : "ready";
}

/**
 * The pick's photos in display order. Falls back to a single synthetic entry built from `photoPath`
 * so every consumer can treat picks uniformly whether or not the server sends `photos`.
 */
export function photosOf(p: PickWithAnalysis | null | undefined): PickPhotoView[] {
  if (!p) return [];
  if (Array.isArray(p.photos) && p.photos.length > 0) {
    return [...p.photos].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  return [{ id: 0, url: p.photoPath, position: 0, analysisStatus: analysisStatusOf(p), analysisError: p.analysisError ?? null, itemCount: p.items?.length ?? 0, synthetic: true }];
}

/** Cover photo URL for cards and the closet. */
export function coverUrlOf(p: PickWithAnalysis): string {
  return photosOf(p)[0]?.url ?? p.photoPath;
}

export const ANALYSIS_POLL_MS = 2500;
