import fs from "node:fs";
import type { GarmentItem, GarmentFit } from "@shared/schema";
import { GARMENT_FITS } from "@shared/schema";

export interface OutfitAnalysis {
  palette: string[];
  items: GarmentItem[];
  summary: string;
}

const BRAND_SEARCH: Record<string, string> = {
  lululemon: "https://shop.lululemon.com/search?Ntt=",
  alo: "https://www.aloyoga.com/search?q=",
  "alo yoga": "https://www.aloyoga.com/search?q=",
  vuori: "https://vuoriclothing.com/search?q=",
  nike: "https://www.nike.com/w?q=",
  gymshark: "https://www.gymshark.com/search?q=",
  athleta: "https://athleta.gap.com/browse/search.do?searchText=",
  "free people": "https://www.freepeople.com/search?q=",
  "fp movement": "https://www.freepeople.com/search?q=",
  adidas: "https://www.adidas.com/us/search?q=",
  "under armour": "https://www.underarmour.com/en-us/search?q=",
  "set active": "https://www.setactive.co/search?q=",
  fabletics: "https://www.fabletics.com/search?q=",
  hoka: "https://www.hoka.com/en/us/search?q=",
  "on running": "https://www.on.com/en-us/search?q=",
  on: "https://www.on.com/en-us/search?q=",
  brooks: "https://www.brooksrunning.com/en_us/search/?q=",
  "new balance": "https://www.newbalance.com/search?q=",
  asics: "https://www.asics.com/us/en-us/search/?q=",
};

export function buildLinks(query: string, brand: string | null): { label: string; url: string }[] {
  const q = encodeURIComponent(query);
  const links = [
    { label: "Compare prices", url: `https://www.google.com/search?tbm=shop&q=${q}` },
    { label: "Amazon", url: `https://www.amazon.com/s?k=${q}` },
  ];
  const b = brand?.toLowerCase().trim();
  if (b && BRAND_SEARCH[b]) {
    const shortQuery = encodeURIComponent(query.replace(new RegExp(brand!, "i"), "").trim());
    links.push({ label: `${brand} site`, url: `${BRAND_SEARCH[b]}${shortQuery}` });
  }
  return links;
}

const SYSTEM = `You identify activewear and athleisure garments in a photo so friends can coordinate outfits and shop for the pieces.
The photo is ONE of two kinds:
  (a) a full outfit worn by a person (mirror selfie, full-body shot), or
  (b) a SINGLE piece shown on its own: a garment, pair of shoes or accessory laid flat on a bed/floor, on a hanger, held up to the camera, or a product-style shot.
Describe only what is actually visible. Never invent pieces that are not in the frame (no "probably wearing shoes" for a flat-lay top; no bottoms for a hanging jacket). For (b) return 1-2 items (the piece itself, plus a second one only if a second distinct piece is clearly in the shot).
Return ONLY compact JSON with this exact shape and nothing else:
{"summary": string, "palette": string[], "items": [{"category": string, "description": string, "colorName": string, "colorHex": string, "brandGuess": string|null, "searchQuery": string, "fit": "womens"|"mens"|"unisex"}]}
Rules:
- summary: 6-12 words describing what is in the photo, e.g. "Black high-rise leggings with sage cropped tank" or, for a single piece, "Sage green ribbed cropped tank top".
- palette: 2-4 dominant garment colors as hex, most prominent first. Ignore skin, hair, hangers, bedding and background.
- items: one entry per visible garment, shoe or accessory (sports bra, tank, leggings, shorts, hoodie, jacket, shoes, socks, hat, bag). Full outfit: 2-6 items. Single piece: 1-2 items.
- brandGuess: only if a logo or unmistakable signature is visible; otherwise null. Never guess.
- searchQuery: 4-8 words a shopper would type to find this exact style, including color, fit and brand if known. Example: "lululemon align high rise legging black 25". Do NOT add "women's"/"men's" here; use the fit field.
- fit: the department this piece is sold in, judged from the garment's own cut and styling, never from the wearer. "womens" for sports bras, leggings with a high-rise yoga cut, cropped tanks, skorts, bike shorts with a women's cut, flared pants; "mens" for boxy tees, basketball/7" lined shorts, men's compression gear or cuts clearly from a men's line; "unisex" for hoodies, crewnecks, socks, hats, bags, sneakers and whenever you are not sure. Default to "unisex".
- colorHex: a real hex like #1F1F1F.`;

const GEMINI_HOST = "https://generativelanguage.googleapis.com";
const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",");

/**
 * Resolve how to reach Gemini:
 * 1. Published / dev with a saved credential: the platform injects a proxy URL + proxy auth key env vars.
 * 2. Plain hosting (Render etc.): GEMINI_API_KEY env var, sent as x-goog-api-key.
 */
function geminiTarget(model: string): { url: string; headers: Record<string, string> } {
  const proxyUrl = process.env.CUSTOM_CRED_GENERATIVELANGUAGE_GOOGLEAPIS_COM_URL;
  const proxyKey = process.env.CUSTOM_CRED_GENERATIVELANGUAGE_GOOGLEAPIS_COM_PROXY_AUTH_KEY;
  const path = `/v1beta/models/${model}:generateContent`;
  if (proxyUrl && proxyKey) return { url: `${proxyUrl.replace(/\/$/, "")}${path}`, headers: { "x-api-key": proxyKey } };
  if (process.env.GEMINI_API_KEY) return { url: `${GEMINI_HOST}${path}`, headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } };
  // Dev sandbox with api_credentials: the HTTPS proxy injects auth automatically.
  return { url: `${GEMINI_HOST}${path}`, headers: {} };
}

export async function analyzeOutfit(image: Buffer | string, mimeType: string): Promise<OutfitAnalysis> {
  // Test hook (tests/test_prices_mock.py): skip Gemini and use a canned analysis.
  if (process.env.MOCK_VISION_JSON) return normalizeAnalysis(JSON.parse(process.env.MOCK_VISION_JSON));
  const data = (Buffer.isBuffer(image) ? image : fs.readFileSync(image)).toString("base64");
  const mediaType = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType) ? mimeType : "image/jpeg";
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mediaType, data } }, { text: "Identify the garments. JSON only." }] }],
    generationConfig: {
      temperature: 0.2,
      // maxOutputTokens INCLUDES thinking tokens on Gemini 3.x; the old 1200 cap truncated real outfit
      // photos mid-JSON ("Unexpected end of JSON input"). Keep thinking low and leave headroom.
      // https://ai.google.dev/gemini-api/docs/thinking
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  // Some models reject thinkingConfig; retry those without it.
  const payloadNoThinking = payload.replace(/,\s*"thinkingConfig":\{[^}]*\}/, "");

  // Try each model in order. 429 (quota): pause 1.5 s and retry the same model; 503 ("high demand"): move to the
  // next model immediately - pausing/retrying per model stretched a live analysis to ~56 s when several were busy.
  type GeminiBody = { candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  let lastErr = "";
  for (const rawModel of GEMINI_MODELS) {
    const model = rawModel.trim();
    const { url, headers } = geminiTarget(model);
    let useThinkingCfg = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: useThinkingCfg ? payload : payloadNoThinking,
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200);
        lastErr = `Gemini ${model} ${res.status}: ${errText}`;
        if (res.status === 400 && useThinkingCfg && /thinking/i.test(errText)) {
          useThinkingCfg = false; // model doesn't accept thinkingConfig → retry plain
          continue;
        }
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        break; // 503 / 404 / 400 etc: next model right away
      }
      const body = (await res.json()) as GeminiBody;
      const cand = body.candidates?.[0];
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return normalizeAnalysis(JSON.parse(text.slice(start, end + 1)));
        } catch (e) {
          lastErr = `Gemini ${model}: unparseable JSON (${(e as Error).message}; finishReason=${cand?.finishReason ?? "?"})`;
        }
      } else {
        lastErr = `Gemini ${model}: empty output (finishReason=${cand?.finishReason ?? "?"})`;
      }
      console.warn(`[vision] ${lastErr}; trying next model`);
      break; // bad output from this model → next model
    }
  }
  throw new Error(lastErr || "Gemini unavailable");
}

/** Coerce whatever the model returned for `fit` to a known value; anything unknown/missing → "unisex". */
export function normalizeFit(v: unknown): GarmentFit {
  const s = typeof v === "string" ? v.toLowerCase().replace(/['\s]/g, "") : "";
  if (s === "women" || s === "womens" || s === "female" || s === "ladies") return "womens";
  if (s === "men" || s === "mens" || s === "male") return "mens";
  return (GARMENT_FITS as readonly string[]).includes(s) ? (s as GarmentFit) : "unisex";
}

function normalizeAnalysis(parsed: { summary?: string; palette?: string[]; items?: (Omit<GarmentItem, "links" | "fit"> & { fit?: unknown })[] }): OutfitAnalysis {
  const palette = (parsed.palette ?? []).filter((h) => /^#[0-9a-f]{6}$/i.test(h)).slice(0, 4);
  const items: GarmentItem[] = (parsed.items ?? []).slice(0, 6).map((it) => ({
    category: it.category ?? "item",
    description: it.description ?? "",
    colorName: it.colorName ?? "",
    colorHex: /^#[0-9a-f]{6}$/i.test(it.colorHex ?? "") ? it.colorHex : "#888888",
    brandGuess: it.brandGuess || null,
    searchQuery: it.searchQuery || `${it.colorName ?? ""} ${it.description ?? it.category ?? ""}`.trim(),
    fit: normalizeFit(it.fit),
    // Stored un-hinted; storage.pickView re-derives Compare prices / Amazon urls from the hinted query at read time.
    links: buildLinks(it.searchQuery || `${it.colorName ?? ""} ${it.description ?? ""}`.trim(), it.brandGuess || null),
  }));

  return { palette, items, summary: parsed.summary ?? "" };
}
