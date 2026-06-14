/**
 * 計時類運動秒數解析（滑步車、游泳…共用）
 *
 * 規則優先（快又穩，涵蓋常見格式與多筆），看不懂才丟 Gemini 整理。
 * 需要環境變數：GEMINI_API_KEY（沒有則只用規則）
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let model = null;

export function initParseGemini() {
  if (model) return true;
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('[timing-parse] no GEMINI_API_KEY — 只用規則解析');
    return false;
  }
  const genAI = new GoogleGenerativeAI(key);
  model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  console.log('[timing-parse] Gemini 2.5 Flash ready（規則 fallback）');
  return true;
}

// 分段符號：換行、逗號、頓號、分號
const SEP = /[\n,，、;；]+/;
// 名稱：開頭連續的中文/英文字
const NAME_RE = /^\s*([一-龥A-Za-z·]+)/;

// 全形數字/小數點/空格 → 半形
function normalizeDigits(s) {
  return String(s)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.')
    .replace(/　/g, ' ');
}

// 把 categories 設定攤平成 [{alias, name}]，長的別名優先（避免 自 先吃掉 自由式）
function buildAliasList(categories) {
  if (!categories) return null;
  const list = [];
  for (const c of categories) for (const a of c.aliases) list.push({ alias: a, name: c.name });
  list.sort((x, y) => y.alias.length - x.alias.length);
  return list;
}

/**
 * 規則解析（回傳 [{name, distance, seconds, category?}]）
 * 每段格式：<名稱> [分類] <距離> <秒數1> [秒數2 ...]
 *   - 單位（米/公尺/秒）可有可無
 *   - 第一個數字 = 距離，其餘 = 多筆秒數（同距離多趟）
 *   - opts.categories 給定時（如泳式），須含分類關鍵字
 *   - 接續沿用：同一則訊息內，後段省略的「名字 / 距離 / 分類」自動沿用前一段
 * 例：鈞鈞 10 2.0 2.1 / 鈞鈞 10 2.0、2.1 / 綸綸 自由式 50 45、52
 */
export function parseRecordsRegex(text, opts = {}) {
  const aliasList = buildAliasList(opts.categories);
  const out = [];
  let lastName = null, lastDistance = null, lastCategory = null;
  for (const seg0 of normalizeDigits(text).split(SEP)) {
    let s = seg0.trim();
    if (!s) continue;

    // 分類（如泳式）：找不到就沿用前一段
    let category = null;
    if (aliasList) {
      const found = aliasList.find(a => s.includes(a.alias));
      if (found) { category = found.name; s = s.replace(found.alias, ' '); }
    }

    // 名稱：找不到就沿用前一段
    const nameM = s.match(NAME_RE);
    let name = nameM ? nameM[1].trim() : null;
    const rest = nameM ? s.slice(nameM[0].length) : s;
    const nums = (rest.match(/\d+(?:\.\d+)?/g) || []).map(Number);

    if (!name) name = lastName;
    if (!name) continue; // 無法歸屬（前面也沒名字）
    if (aliasList) {
      if (!category) category = lastCategory;
      if (!category) continue; // 需要分類但從頭到此都沒給
    }

    // 數字：>=2 → 距離+多秒；=1 → 沿用前一段距離的單筆秒數
    let distance, times;
    if (nums.length >= 2) {
      distance = Math.round(nums[0]);
      times = nums.slice(1);
    } else if (nums.length === 1) {
      if (lastDistance == null) continue;
      distance = lastDistance;
      times = [nums[0]];
    } else {
      continue;
    }
    if (distance <= 0) continue;

    // 更新接續狀態
    lastName = name;
    lastDistance = distance;
    if (category) lastCategory = category;

    for (const sec of times) {
      if (sec > 0) out.push(category ? { name, category, distance, seconds: sec } : { name, distance, seconds: sec });
    }
  }
  return out;
}

/** Gemini 解析（規則失敗才用） */
export async function parseRecordsGemini(text, opts = {}) {
  if (!model) return [];
  const cats = opts.categories;
  const catNames = cats ? cats.map(c => c.name).join('/') : '';
  const fmt = cats
    ? `{"name":"選手名","category":"分類（${catNames}）","distance":距離公尺數(整數),"seconds":秒數(數字)}`
    : `{"name":"選手名","distance":距離公尺數(整數),"seconds":秒數(數字)}`;
  const catRule = cats ? `\n- category 必須是 ${catNames} 其中之一，判斷不出就略過該筆` : '';
  const prompt = `把以下文字解析成運動秒數記錄，回傳純 JSON 陣列（不要 markdown code fence）：
${text}

每筆格式：${fmt}
規則：
- 一句可能含多位選手、多筆記錄，全部拆開成陣列
- distance 是公尺數字（如 10米 → 10、50米 → 50），seconds 是秒數（如 2.1秒 → 2.1）${catRule}
- 完全解析不到就回 []`;
  try {
    const res = await model.generateContent(prompt);
    const t = res.response.text();
    const match = t.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(r => r && r.name && +r.distance > 0 && +r.seconds > 0 && (!cats || r.category))
      .map(r => {
        const base = { name: String(r.name).trim(), distance: Math.round(+r.distance), seconds: +r.seconds };
        return cats ? { ...base, category: String(r.category).trim() } : base;
      });
  } catch (err) {
    console.error('[timing-parse] gemini error:', err.message);
    return [];
  }
}

/** 主入口：規則優先，失敗才 Gemini */
export async function parseRecords(text, opts = {}) {
  const r = parseRecordsRegex(text, opts);
  if (r.length) return r;
  return await parseRecordsGemini(text, opts);
}
