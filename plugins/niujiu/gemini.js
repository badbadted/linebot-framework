/**
 * AI 餐廳辨識 + 資訊補充（Claude ＋ 網路搜尋）
 *
 * 從 resolve-pending.ts 搬過來，改為 firebase-admin + ESM
 * 2026-10-25 由 Gemini＋Google Search 改為 Claude Sonnet 5.5：走 Luna /api/ext/llm（webSearch），
 * 金鑰在 Luna，這裡不需要任何 API key。需求 Provider：llm（luna，需有 generate）
 */

let llm = null;

const FETCH_TIMEOUT_MS = 8000;
const GEMINI_TIMEOUT_MS = 30000; // 單次 AI 搜尋上限（名稱沿用，Gemini 時代就是這個值）
const SEARCH_MAX_USES = 3;       // 每次最多搜幾次網路（每千次約 10 美元）

// LINE reply token 收到訊息後 1 分鐘內要用掉。一次 /美食 可能連續呼叫兩次 AI（找店＋補資訊），
// 兩次都用滿 30 秒會超過期限、回覆變成私訊推播，所以整趟限 50 秒（留時間寫入與回覆）：
// 補資訊只用剩下的時間，剩不到 MIN_ENRICH_MS 就跳過，直接用找到的資料寫入
export const REPLY_BUDGET_MS = 50000;
const MIN_ENRICH_MS = 5000;

// 帶逾時的 fetch：目標網站卡住時主動 abort，避免 /美食 整個請求無限掛住、replyToken 失效
async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── 初始化 ──────────────────────────────────────────

export function initGemini(llmProvider) {
  if (!llmProvider?.generate) {
    console.warn('[niujiu-ai] llm provider 沒有 generate()（需要 Luna）— 找店／補資訊停用');
    return false;
  }
  llm = llmProvider;
  console.log('[niujiu-ai] Claude Sonnet + 網路搜尋 ready（經 Luna）');
  return true;
}

export function isGeminiReady() {
  return llm !== null;
}

/** 帶網路搜尋問 AI，回傳文字 */
async function askWithSearch(prompt, timeoutMs) {
  return llm.generate({
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 3000,
    webSearch: { maxUses: SEARCH_MAX_USES },
    model: 'sonnet', // 找店要準：Sonnet 有篩選搜尋結果的新版搜尋工具，實測單次約 9～10 秒
    effort: 'medium',
    timeoutMs,
  });
}

/** 從 AI 回傳文字中提取 JSON，容錯處理 */
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
    console.error('[niujiu-ai] JSON parse failed:', cleaned.slice(0, 100));
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
        // 國際格式「店名, 地址」→ 取第一個逗號前
        // 例：Zaru-Yaki Kobayashi Poultry (Shinbashi Branch), 3 Chome-14-1 Shinbashi, ... → Zaru-Yaki Kobayashi Poultry (Shinbashi Branch)
        // 台灣格式「地址+店名」→ 去掉地址，取後段中文詞組作為店名
        // 例：701臺南市東區大智里生產路504號佳福川味牛肉麵 → 佳福川味牛肉麵
        const commaIdx = decoded.search(/[,，]/);
        const nameFromQ = commaIdx > 0
          ? decoded.slice(0, commaIdx).trim()
          : decoded.replace(/^\d{3,5}/, '')              // 郵遞區號
            .replace(/^.+?[號巷弄樓室F]+/, '')            // 地址部分
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
  const res = await fetchWithTimeout(shortUrl, {
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

// ── Phase 1B: 外部 URL（IG、部落格）→ AI 搜尋辨識 ──

// FB／IG 只對自家預覽爬蟲吐 OG meta；完整的 UA 字串才認得
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const HINT_MAX = 1200;

const decodeEntities = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

/** 從網頁 HTML 取出預覽文字：og:title（FB 會放完整貼文說明）＋ og:description，重複的去掉 */
export function previewHintFromHtml(html) {
  const meta = (key) => html.match(new RegExp(`(?:property|name)="${key}"[^>]*content="([^"]*)"`))?.[1]
    || html.match(new RegExp(`content="([^"]*)"[^>]*(?:property|name)="${key}"`))?.[1] || '';
  const title = decodeEntities(meta('og:title') || html.match(/<title[^>]*>([^<]*)</)?.[1] || '').trim();
  const desc = decodeEntities(meta('og:description') || meta('description')).trim();
  if (/^(facebook|instagram|log in|登入)$/i.test(title) && !desc) return '';
  // FB 的 og:description 是 og:title 後半段截斷版，被包含就不重複放
  const parts = desc && title.includes(desc.replace(/\.{3}$/, '').slice(0, 40)) ? [title] : [title, desc];
  return parts.filter(Boolean).join(' — ').slice(0, HINT_MAX);
}

async function fetchPreviewHint(url) {
  const get = async (u) => {
    const res = await fetchWithTimeout(u, { redirect: 'follow', headers: { 'User-Agent': PREVIEW_UA } });
    return { finalUrl: res.url || u, html: await res.text() };
  };
  const first = await get(url);
  let hint = previewHintFromHtml(first.html);
  // FB 分享短連結轉址後會帶一串參數，帶著參數常只拿到登入牆 → 去掉參數再抓一次
  if (!hint && /(facebook|instagram)\.com\/.*\?/.test(first.finalUrl)) {
    hint = previewHintFromHtml((await get(first.finalUrl.split('?')[0])).html);
  }
  return hint;
}

export async function resolveExternalUrl(url) {
  if (!llm) throw new Error('AI search not initialized');

  // 先嘗試 fetch OG meta 取得線索（貼文說明常寫店名、📍地點）
  let hint = '';
  try {
    hint = await fetchPreviewHint(url);
  } catch { /* fetch 失敗就靠 AI 搜尋 */ }

  const isIG = /instagram\.com/.test(url);
  const isFB = /facebook\.com/.test(url);
  const hintBlock = hint ? `\n網頁預覽：${hint}` : '';
  const platformWarn = (isIG || isFB)
    ? `\n⚠️ 注意：網頁預覽中的帳號名稱（如「吃吃霞」「美食日記」）是發文者帳號，不是餐廳名稱！請搜尋這則貼文實際介紹的餐廳。`
    : '';

  const prompt = `你是餐廳辨識助手。請上網搜尋以下連結中介紹的餐廳：
${url}${hintBlock}${platformWarn}

請搜尋這則貼文（可能是 Instagram Reel、Facebook 貼文、美食部落格等）實際介紹的餐廳。
回傳嚴格 JSON（不要用 markdown code fence 包裹）：

{
  "name": "餐廳店名（找不到填空字串）",
  "address": "餐廳地址（找不到填空字串）",
  "area": "地區，如 台南東區、大阪難波（找不到填空字串）",
  "lat": null,
  "lng": null
}

規則：
- 回傳的是「貼文中介紹的餐廳」，不是「發文者帳號名稱」
- 只辨識一家餐廳（若提到多家，取最主要的那家）
- 貼文介紹的是一個地區或景點、裡面提到吃的（例如「老街裡的百年鰻魚飯」），就用地區＋料理去搜尋，找出最符合的那家店
- 一定要先上網搜尋過才能判斷；沒搜尋不可以直接回空
- lat/lng 如果知道填數字，不知道填 null
- 搜尋後真的找不到就全部填空字串/null，不要猜`;

  const text = await askWithSearch(prompt, GEMINI_TIMEOUT_MS);
  console.log('[niujiu-ai] resolve raw:', text.slice(0, 200));
  return parseResolveResponse(text);
}

/** 解析 Phase 1 回傳的 { name, address, area, lat, lng } JSON */
function parseResolveResponse(text) {
  return pickPlaceFields(safeParseJson(text));
}

/** 取出 { name, address, area, lat, lng } 中有值的欄位 */
function pickPlaceFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  if (typeof obj.name === 'string' && obj.name.trim()) out.name = obj.name.trim();
  if (typeof obj.address === 'string' && obj.address.trim()) out.address = obj.address.trim();
  if (typeof obj.area === 'string' && obj.area.trim()) out.area = obj.area.trim();
  if (typeof obj.lat === 'number') out.lat = obj.lat;
  if (typeof obj.lng === 'number') out.lng = obj.lng;
  return out;
}

// ── Phase 1C: 純文字（店名／地區）→ AI 上網搜尋找 Google Maps 上的店 ──

/** 沒有原始連結時，用店名＋地址組 Google Maps 搜尋連結存檔 */
export function buildMapsSearchUrl(name, address) {
  const query = [name, address].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const MAX_TEXT_CANDIDATES = 3;

/**
 * 文字找店：回傳最多 3 家候選 [{ name, address, area, lat, lng }]，最相關的在前
 * 文字有地區線索或明確只有一家時只回一家；找不到回 []
 */
export async function searchTextCandidates(query) {
  if (!llm) throw new Error('AI search not initialized');

  const prompt = `你是餐廳辨識助手。使用者輸入一段文字，想找 Google Maps 上對應的餐廳：
「${query}」

請上網搜尋找出符合的餐廳（文字可能含店名、地區、菜色等線索）。
回傳嚴格 JSON（不要用 markdown code fence 包裹）：

{
  "candidates": [
    { "name": "Google Maps 上的店名", "address": "完整地址", "area": "簡短地區，如 台南東區、東京築地", "lat": null, "lng": null }
  ]
}

規則：
- 文字含地區線索時，只回傳該地區符合的店
- 文字沒有地區線索時，若同名店有多家分店、或在不同城市／國家都有，必須各列一筆（最多 ${MAX_TEXT_CANDIDATES} 筆，最相關的排前面），不要只挑一家
- 全世界確定只有一家時才只回傳一家
- 店名與地址以搜尋到的資料為準，不要自行組合或猜測；分店要寫出分店名
- lat/lng 如果知道填數字，不知道填 null
- 找不到確定存在的餐廳就回傳 {"candidates": []}`;

  const text = await askWithSearch(prompt, GEMINI_TIMEOUT_MS);
  console.log('[niujiu-ai] text candidates raw:', text.slice(0, 300));
  const list = safeParseJson(text)?.candidates;
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  return list
    .map(pickPlaceFields)
    .filter(c => {
      const key = `${c.name}|${c.address || ''}`;
      if (!c.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TEXT_CANDIDATES);
}

// ── Phase 2: Enrich 餐廳資訊（AI ＋ 網路搜尋） ──

const ENRICHMENT_KEYS = ['address', 'area', 'summary', 'googleRating', 'tabelogRating', 'priceDetail', 'hours', 'access'];

export function needsEnrichment(data) {
  return ENRICHMENT_KEYS.some(key => !data[key] || (typeof data[key] === 'string' && !data[key].trim()));
}

const GEOCODE_TIMEOUT_MS = 4000;

function hasCoords(place) {
  return typeof place.lat === 'number' && typeof place.lng === 'number';
}

/**
 * 座標 → 所在位置文字（如「羽田四丁目, 羽田, 大田區, 東京都, 144-0043, 日本」），查不到回 ''
 * 用 OpenStreetMap Nominatim（免金鑰）。AI 光看座標數字會判錯行政區，所以先查好再給它
 */
export async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=zh-TW&lat=${lat}&lon=${lng}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'linebot-framework-niujiu/1.0' },
    }, GEOCODE_TIMEOUT_MS);
    if (!res.ok) return '';
    const data = await res.json();
    return typeof data.display_name === 'string' ? data.display_name.trim() : '';
  } catch (err) {
    console.warn('[niujiu-ai] reverse geocode failed:', err.message);
    return '';
  }
}

// Google Maps 連結只解得出店名與座標。只給店名的話，同名店（如東京與神戶的 Takakura）
// 會被補成另一家的資料，所以有座標就把搜尋鎖在那個位置
function buildEnrichPrompt({ name, address, area, lat, lng, locality }) {
  const pinned = hasCoords({ lat, lng });
  return `你是餐廳資訊整理助手。搜尋以下餐廳的最新資訊，回傳嚴格 JSON（不要用 markdown code fence 包裹）：
餐廳：${name}
${address ? `地址：${address}` : ''}
${area ? `地區：${area}` : ''}
${pinned ? `座標：${lat}, ${lng}（這家店在 Google Maps 上的實際位置）` : ''}
${locality ? `座標所在位置：${locality}` : ''}

請回傳以下格式的 JSON：
{
  "address": "完整地址，如 台南市東區崇明路482號（${address ? '已知可跳過' : '必填'}）",
  "area": "簡短地區名，如 台南東區、大阪難波（${area ? '已知可跳過' : '必填'}）",
  "summary": "一句話描述餐廳特色（${SUMMARY_PROMPT_CHARS}字以內，不要換行）",
  "googleRating": "Google 評分數字，如 4.6（找不到填空字串）",
  "tabelogRating": "食べログ評分，如 3.43（找不到填空字串）",
  "priceDetail": "價位範圍，如 午餐 ¥3,000–4,000・晚餐 ¥10,000–15,000",
  "hours": "營業時間，多行以\\n分隔",
  "access": "最近車站或地標＋步行時間，如 心齋橋站6號出口・步行5分"
}

規則：
- 找不到的欄位填空字串 ""
${pinned ? `- 只採用位於座標所在位置的這家店的資料；其他城市或國家的同名店不是這家，資料一律不可使用
- 在座標所在位置找不到這家店時，area 填座標所在的城市行政區${locality ? '' : '（無法確定就填空字串）'}，其餘欄位全部填空字串，不要拿同名店的資料來填
` : ''}- 不要加任何解釋或前後文，只回傳純 JSON`;
}

export const SUMMARY_MAX_CHARS = 30;
// 提示裡要求的字數比上限短，讓多數回覆本來就不必截
const SUMMARY_PROMPT_CHARS = 20;
// 在標點截斷後至少要留這麼多字，不然寧可硬切（避免「好吃，……」只剩「好吃」）
const SUMMARY_MIN_CLAUSE_CHARS = 10;
// 頓號不當斷點：它分隔的是並列項目，在那裡斷會留下「招牌是芋頭米粉」這種只列一半的清單
const SUMMARY_BREAK_RE = /[，；。！？,;!?]/;
const SUMMARY_TRAILING_RE = /[\s，、；。！？,;!?：:]+$/;

/**
 * summary 超過上限時截短：優先在上限內最後一個標點處斷句，沒有合適的標點才硬切加「…」
 * AI 不一定遵守提示裡的字數要求，所以收到後一律過這道
 * 字數以 code point 計（emoji、罕用字算一個字）
 */
export function clampSummary(text, max = SUMMARY_MAX_CHARS) {
  if (typeof text !== 'string') return '';
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');

  // 斷點可以落在第 max 個字之後的那個標點（剛好 max 個字＋標點的情況）
  const head = chars.slice(0, max + 1);
  let cut = -1;
  for (let i = head.length - 1; i >= SUMMARY_MIN_CLAUSE_CHARS; i--) {
    if (SUMMARY_BREAK_RE.test(head[i])) { cut = i; break; }
  }
  if (cut !== -1) {
    return chars.slice(0, cut).join('').replace(SUMMARY_TRAILING_RE, '');
  }
  return chars.slice(0, max - 1).join('').replace(SUMMARY_TRAILING_RE, '') + '…';
}

export function parseEnrichResponse(text) {
  const parsed = safeParseJson(text);
  if (!parsed) return {};
  const fields = {};
  for (const key of ENRICHMENT_KEYS) {
    if (parsed[key] && typeof parsed[key] === 'string' && parsed[key].trim()) {
      fields[key] = parsed[key].trim();
    }
  }
  if (fields.summary) {
    const clamped = clampSummary(fields.summary);
    if (clamped !== fields.summary) {
      console.log(`[niujiu-ai] summary clamped ${Array.from(fields.summary).length} → ${Array.from(clamped).length} chars`);
    }
    fields.summary = clamped;
  }
  return fields;
}

/**
 * 對單筆餐廳做 enrich（resolve 完才能跑）
 * @returns {object|null} enriched fields or null
 */
export async function enrichRestaurant(place, timeoutMs = GEMINI_TIMEOUT_MS) {
  if (!llm) throw new Error('AI search not initialized');

  const prompt = buildEnrichPrompt(place);
  const text = await askWithSearch(prompt, timeoutMs);
  return parseEnrichResponse(text);
}

/**
 * 完整流程：resolve URL + enrich，回傳合併結果
 * @returns {{ name, address, area, summary, googleRating, ... , status }}
 */
export async function resolveAndEnrich(url, deadline = Date.now() + REPLY_BUDGET_MS) {
  // Phase 1: Resolve
  const resolved = isGoogleMapsUrl(url)
    ? await resolveGoogleMapsUrl(url)
    : await resolveExternalUrl(url);
  return enrichResolved(resolved, deadline);
}

/**
 * 對文字搜尋選定的候選店補資訊，回傳格式同 resolveAndEnrich
 * @param {number} [deadline] 同一趟回覆的截止時間（ms）；沒給就用完整的 AI 逾時
 */
export async function enrichCandidate(candidate, deadline) {
  return enrichResolved(candidate, deadline);
}

async function enrichResolved(resolved, deadline) {
  if (!resolved.name) {
    return { status: 'failed' };
  }

  // Phase 2: Enrich（只用到回覆截止前剩下的時間）
  let enriched = {};
  const remaining = deadline ? deadline - Date.now() : GEMINI_TIMEOUT_MS;
  const timeoutMs = Math.min(GEMINI_TIMEOUT_MS, remaining);
  if (timeoutMs < MIN_ENRICH_MS) {
    console.warn(`[niujiu-ai] skip enrich for ${resolved.name}: only ${remaining}ms left before reply deadline`);
  } else {
    try {
      // 只有店名＋座標（Maps 連結）時先查出所在位置，當成找店的地區線索
      const locality = hasCoords(resolved) && !resolved.address && !resolved.area
        ? await reverseGeocode(resolved.lat, resolved.lng)
        : '';
      // 查位置最多花掉 GEOCODE_TIMEOUT_MS，AI 用扣掉之後剩下的時間
      const left = deadline ? Math.min(GEMINI_TIMEOUT_MS, deadline - Date.now()) : timeoutMs;
      enriched = await enrichRestaurant({ ...resolved, locality }, left);
    } catch (err) {
      console.error(`[niujiu-ai] enrich error for ${resolved.name}:`, err.message);
      // resolve 成功但 enrich 失敗，仍回傳 resolved 資料
    }
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
