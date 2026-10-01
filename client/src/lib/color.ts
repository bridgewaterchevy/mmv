export interface HSL { h: number; s: number; l: number }

export function hexToHsl(hex: string): HSL {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

const isNeutral = (c: HSL) => c.s < 0.14 || c.l < 0.12 || c.l > 0.92;
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** 0..1 how well two colors sit together in one outfit story */
export function pairScore(a: string, b: string): number {
  const ca = hexToHsl(a), cb = hexToHsl(b);
  const na = isNeutral(ca), nb = isNeutral(cb);
  if (na && nb) return Math.abs(ca.l - cb.l) < 0.25 ? 1 : 0.85; // black+black vs black+white
  if (na || nb) return 0.75; // neutrals go with anything
  const d = hueDist(ca.h, cb.h);
  if (d <= 18) return 1; // same family
  if (d <= 50) return 0.7; // analogous
  if (d >= 150 && d <= 210) return 0.8; // complementary
  return 0.35; // clash
}

export type MatchLevel = "matching" | "coordinated" | "mixed" | "clashing" | "waiting";

export interface MatchResult { score: number; level: MatchLevel; label: string; detail: string }

/** For each pair of members: how well does each person's main color sit with anything the other is wearing? */
export function matchScore(palettes: string[][]): MatchResult {
  const ps = palettes.filter((p) => p.length > 0).map((p) => p.slice(0, 3));
  if (ps.length < 2) return { score: 0, level: "waiting", label: "Waiting on picks", detail: "Two or more picks unlock the match meter." };
  const bestAgainst = (c: string, other: string[]) => Math.max(...other.map((o) => pairScore(c, o)));
  let total = 0, n = 0;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      total += (bestAgainst(ps[i][0], ps[j]) + bestAgainst(ps[j][0], ps[i])) / 2;
      n++;
    }
  const score = total / n;
  if (score >= 0.92) return { score, level: "matching", label: "Matching", detail: "Same color story across the crew." };
  if (score >= 0.72) return { score, level: "coordinated", label: "Coordinated", detail: "Different pieces, one palette." };
  if (score >= 0.5) return { score, level: "mixed", label: "Mixed", detail: "Some picks pull in different directions." };
  return { score, level: "clashing", label: "Clashing", detail: "Someone may want to swap a piece." };
}

export function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function todayIso(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
