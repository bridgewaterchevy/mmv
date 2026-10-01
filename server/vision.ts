import fs from "node:fs";
import type { GarmentItem } from "@shared/schema";

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
Return ONLY compact JSON with this exact shape and nothing else:
{"summary": string, "palette": string[], "items": [{"category": string, "description": string, "colorName": string, "colorHex": string, "brandGuess": string|null, "searchQuery": string}]}
Rules:
- summary: 6-12 words describing the outfit, e.g. "Black high-rise leggings with sage cropped tank".
- palette: 2-4 dominant outfit colors as hex, most prominent first. Ignore skin, hair and background.
- items: one entry per visible garment or shoe (sports bra, tank, leggings, shorts, hoodie, jacket, shoes, socks, hat, bag). 2-6 items.
- brandGuess: only if a logo or unmistakable signature is visible; otherwise null. Never guess.
- searchQuery: 4-8 words a shopper would type to find this exact style, including color, fit and brand if known. Example: "lululemon align high rise legging black 25".
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
  const data = (Buffer.isBuffer(image) ? image : fs.readFileSync(image)).toString("base64");
  const mediaType = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType) ? mimeType : "image/jpeg";
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mediaType, data } }, { text: "Identify the garments. JSON only." }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: "application/json" },
  });

  // Try each model in order; retry transient 429/503 once per model with a short pause.
  type GeminiBody = { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  let body: GeminiBody | null = null;
  let lastErr = "";
  outer: for (const model of GEMINI_MODELS) {
    const { url, headers } = geminiTarget(model.trim());
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload });
      if (res.ok) {
        body = (await res.json()) as GeminiBody;
        break outer;
      }
      lastErr = `Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break; // 404 / 400 etc: move to next model
    }
  }
  if (!body) throw new Error(lastErr || "Gemini unavailable");
  const result: GeminiBody = body;
  const text = (result.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as {
    summary?: string;
    palette?: string[];
    items?: Omit<GarmentItem, "links">[];
  };

  const palette = (parsed.palette ?? []).filter((h) => /^#[0-9a-f]{6}$/i.test(h)).slice(0, 4);
  const items: GarmentItem[] = (parsed.items ?? []).slice(0, 6).map((it) => ({
    category: it.category ?? "item",
    description: it.description ?? "",
    colorName: it.colorName ?? "",
    colorHex: /^#[0-9a-f]{6}$/i.test(it.colorHex ?? "") ? it.colorHex : "#888888",
    brandGuess: it.brandGuess || null,
    searchQuery: it.searchQuery || `${it.colorName ?? ""} ${it.description ?? it.category ?? ""}`.trim(),
    links: buildLinks(it.searchQuery || `${it.colorName ?? ""} ${it.description ?? ""}`.trim(), it.brandGuess || null),
  }));

  return { palette, items, summary: parsed.summary ?? "" };
}
