/**
 * Gemini AI 餐廳辨識 + 資訊補充
 *
 * 從 resolve-pending.ts 搬過來，改為 firebase-admin + ESM
 * 需要環境變數：GEMINI_API_KEY
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let model = null;

// ── 初始化 ──────────────────────────────────────────

export function initGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('[niujiu-gemini] no GEMINI_API_KEY — resolve/enrich disabled');
    return false;
  }
  const genAI = new GoogleGenerativeAI(key);
  model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    tools: [{ googleSearch: {} }],
  });
  console.log('[niujiu-gemini] Gemini 2.5 Flash + Google Search ready');
  return true;
}

export function isGeminiReady() {
  return model !== null;
}

/** 從 Gemini 回傳文字中提取 JSON，容錯處理 */
function safeParseJson(text) {
  if (!text || !text.trim()) return null;
  // 去 code fence
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  // 嘗試找 JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('[niujiu-gemini] JSON parse failed:', cleaned.slice(0, 100));
    return null;
  }
}

// ── URL 分類 ────────────────────────────────────────

const GOOGLE_MAPS_RE = /google\.\w+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/;

export function isGoogleMapsUrl(url) {
  return GOOGLE_MAPS_RE.test(url);
}

// ── Phase 1A: Google Maps 短連結 → follow redirect → 解析 ──

const PLACE_NAME_RE = /google\.\w+\/maps\/place\/([^/@]+)/;
const COORDS_AT_RE = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/;
const COORDS_DATA_RE = /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/;
const PLACE_URL_RE = /https?:\/\/www\.google\.\w+\/maps\/place\/[^"'\\<> ]+/;

function parseLongUrl(url) {
  const out = {};

  // 方式1: /maps/place/<name>/@lat,lng
  const nameMatch = url.match(PLACE_NAME_RE);
  if (nameMatch?.[1]) {
    out.name = decodeURIComponent(nameMatch[1].replace(/\+/g, ' ')).trim();
  }

  // 方式2: ?q=<地址+店名>（從 q 參數尾端提取店名）
  if (!out.name) {
    try {
      const u = new URL(url);
      const q = u.searchParams.get('q');
      if (q) {
        const decoded = decodeURIComponent(q);
        // q 通常是「地址+店名」，取最後一個中文詞組作為店名
        // 例：701臺南市東區大智里生產路504號佳福川味牛肉麵 → 佳福川味牛肉麵
        const nameFromQ = decoded.replace(/^\d{3,5}/, '') // 郵遞區號
          .replace(/^.+?[號巷弄樓室F]+/, '')              // 地址部分
          .trim();
        if (nameFromQ) out.name = nameFromQ;
        // fallback: 整段 q 當作名稱（至少有東西）
        if (!out.name && decoded.length < 50) out.name = decoded;
      }
    } catch { /* not a valid URL */ }
  }

  const coords = url.match(COORDS_DATA_RE) || url.match(COORDS_AT_RE);
  if (coords) {
    out.lat = parseFloat(coords[1]);
    out.lng = parseFloat(coords[2]);
  }
  return out;
}

export async function resolveGoogleMapsUrl(shortUrl) {
  const res = await fetch(shortUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  let parsed = parseLongUrl(res.url);
  if (parsed.name) return parsed;

  // Fallback: scan HTML body
  const body = await res.text();
  const urlInBody = body.match(PLACE_URL_RE)?.[0];
  if (urlInBody) {
    parsed = parseLongUrl(urlInBody);
  }
  return parsed;
}

// ── Phase 1B: 外部 URL（IG、部落格）→ Gemini 辨識 ──

export async function resolveExternalUrl(url) {
  if (!model) throw new Error('Gemini not initialized');

  // 先嘗試 fetch OG meta 取得線索
  let hint = '';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    const html = await res.text();
    const title = html.match(/og:title[^>]*content="([^"]*)"/)?.[1]
      || html.match(/<title[^>]*>([^<]*)</)?.[1]
      || '';
    const desc = html.match(/og:description[^>]*content="([^"]*)"/)?.[1]
      || html.match(/description[^>]*content="([^"]*)"/)?.[1]
      || '';
    hint = [title, desc].filter(Boolean).join(' — ').slice(0, 300);
  } catch { /* fetch 失敗就靠 Gemini search */ }

  const hintBlock = hint ? `\n網頁預覽：${hint}` : '';

  const prompt = `你是餐廳辨識助手。請用 Google Search 搜尋以下連結提到的餐廳：
${url}${hintBlock}

請搜尋這個連結相關的餐廳資訊（可能是 Facebook、Instagram、美食部落格、食記等），辨識其中的餐廳。
回傳嚴格 JSON（不要用 markdown code fence 包裹）：

{
  "name": "餐廳名稱（找不到填空字串）",
  "address": "餐廳地址（找不到填空字串）",
  "area": "地區，如 台南東區、大阪難波（找不到填空字串）",
  "lat": null,
  "lng": null
}

規則：
- 只辨識一家餐廳（若提到多家，取最主要的那家）
- lat/lng 如果知道填數字，不知道填 null
- 找不到餐廳就全部填空字串/null`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  console.log('[niujiu-gemini] resolve raw:', text.slice(0, 200));
  const parsed = safeParseJson(text);
  if (!parsed) return {};

  const out = {};
  if (parsed.name?.trim()) out.name = parsed.name.trim();
  if (parsed.address?.trim()) out.address = parsed.address.trim();
  if (parsed.area?.trim()) out.area = parsed.area.trim();
  if (typeof parsed.lat === 'number') out.lat = parsed.lat;
  if (typeof parsed.lng === 'number') out.lng = parsed.lng;
  return out;
}

// ── Phase 2: Enrich 餐廳資訊（Gemini + Google Search） ──

const ENRICHMENT_KEYS = ['address', 'area', 'summary', 'googleRating', 'tabelogRating', 'priceDetail', 'hours', 'access'];

export function needsEnrichment(data) {
  return ENRICHMENT_KEYS.some(key => !data[key] || (typeof data[key] === 'string' && !data[key].trim()));
}

function buildEnrichPrompt(name, address, area) {
  return `你是餐廳資訊整理助手。搜尋以下餐廳的最新資訊，回傳嚴格 JSON（不要用 markdown code fence 包裹）：
餐廳：${name}
${address ? `地址：${address}` : ''}
${area ? `地區：${area}` : ''}

請回傳以下格式的 JSON：
{
  "address": "完整地址，如 台南市東區崇明路482號（${address ? '已知可跳過' : '必填'}）",
  "area": "簡短地區名，如 台南東區、大阪難波（${area ? '已知可跳過' : '必填'}）",
  "summary": "一句話描述餐廳特色（30字以內）",
  "googleRating": "Google 評分數字，如 4.6（找不到填空字串）",
  "tabelogRating": "食べログ評分，如 3.43（找不到填空字串）",
  "priceDetail": "價位範圍，如 午餐 ¥3,000–4,000・晚餐 ¥10,000–15,000",
  "hours": "營業時間，多行以\\n分隔",
  "access": "最近車站或地標＋步行時間，如 心齋橋站6號出口・步行5分"
}

規則：
- 找不到的欄位填空字串 ""
- 不要加任何解釋或前後文，只回傳純 JSON`;
}

function parseEnrichResponse(text) {
  const parsed = safeParseJson(text);
  if (!parsed) return {};
  const fields = {};
  for (const key of ENRICHMENT_KEYS) {
    if (parsed[key] && typeof parsed[key] === 'string' && parsed[key].trim()) {
      fields[key] = parsed[key].trim();
    }
  }
  return fields;
}

/**
 * 對單筆餐廳做 enrich（resolve 完才能跑）
 * @returns {object|null} enriched fields or null
 */
export async function enrichRestaurant(name, address, area) {
  if (!model) throw new Error('Gemini not initialized');

  const prompt = buildEnrichPrompt(name, address, area);
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return parseEnrichResponse(text);
}

/**
 * 完整流程：resolve URL + enrich，回傳合併結果
 * @returns {{ name, address, area, summary, googleRating, ... , status }}
 */
export async function resolveAndEnrich(url) {
  // Phase 1: Resolve
  let resolved;
  if (isGoogleMapsUrl(url)) {
    resolved = await resolveGoogleMapsUrl(url);
  } else {
    resolved = await resolveExternalUrl(url);
  }

  if (!resolved.name) {
    return { status: 'failed' };
  }

  // Phase 2: Enrich
  let enriched = {};
  try {
    enriched = await enrichRestaurant(resolved.name, resolved.address, resolved.area);
  } catch (err) {
    console.error(`[niujiu-gemini] enrich error for ${resolved.name}:`, err.message);
    // resolve 成功但 enrich 失敗，仍回傳 resolved 資料
  }

  const merged = {
    status: 'resolved',
    ...resolved,
    ...enriched,
    name: resolved.name,
    ...(resolved.lat != null ? { lat: resolved.lat } : {}),
    ...(resolved.lng != null ? { lng: resolved.lng } : {}),
  };

  // 過濾 undefined（Firestore 不接受）
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}
