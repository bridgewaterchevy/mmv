import type { PickView } from "@shared/schema";

/**
 * Async outfit analysis state, mirrored from the server contract:
 *   POST /api/sessions/:id/picks → 201 PickView { analysisStatus: "pending", items: [], palette: [] }
 *   GET  /api/picks/:id          → PickView; "ready" fills items/palette, "failed" sets analysisError
 *   POST /api/picks/:id/analyze  → re-queues (owner only)
 * Picks created before the field existed have no analysisStatus and are treated as "ready".
 */
export type AnalysisStatus = "pending" | "ready" | "failed";

export type PickWithAnalysis = PickView & {
  analysisStatus?: AnalysisStatus;
  analysisError?: string | null;
};

export function analysisStatusOf(p: Pick<PickWithAnalysis, "analysisStatus"> | null | undefined): AnalysisStatus {
  const s = p?.analysisStatus;
  return s === "pending" || s === "failed" ? s : "ready";
}

export const ANALYSIS_POLL_MS = 2500;
