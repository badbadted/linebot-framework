/**
 * 滑步車秒數解析
 *
 * 規則優先（快又穩，涵蓋常見格式與多筆），看不懂才丟 Gemini 整理。
 * 需要環境變數：GEMINI_API_KEY（沒有則只用規則）
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let model = null;

export function initParseGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.warn('[bike-parse] no GEMINI_API_KEY — 只用規則解析');
    return false;
  }
  const genAI = new GoogleGenerativeAI(key);
  model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  console.log('[bike-parse] Gemini 2.5 Flash ready（規則 fallback）');
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

/**
 * 規則解析（回傳 [{name, distance, seconds}]）
 * 每段格式：<名稱> <距離> <秒數1> [秒數2 ...]
 *   - 單位（米/公尺/秒）可有可無
 *   - 第一個數字 = 距離，其餘 = 多筆秒數（同距離多趟）
 * 例：鈞鈞 10米2.1秒 / 鈞鈞 10 2.13 2.14 2.15
 */
export function parseRecordsRegex(text) {
  const out = [];
  for (const seg of normalizeDigits(text).split(SEP)) {
    const s = seg.trim();
    if (!s) continue;
    const nameM = s.match(NAME_RE);
    if (!nameM) continue;
    const name = nameM[1].trim();
    const rest = s.slice(nameM[0].length);
    const nums = (rest.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length < 2) continue; // 需要 距離 + 至少一個秒數
    const distance = Math.round(nums[0]);
    if (distance <= 0) continue;
    for (const sec of nums.slice(1)) {
      if (sec > 0) out.push({ name, distance, seconds: sec });
    }
  }
  return out;
}

/** Gemini 解析（規則失敗才用） */
export async function parseRecordsGemini(text) {
  if (!model) return [];
  const prompt = `把以下文字解析成滑步車秒數記錄，回傳純 JSON 陣列（不要 markdown code fence）：
${text}

每筆格式：{"name":"選手名","distance":距離公尺數(整數),"seconds":秒數(數字)}
規則：
- 一句可能含多位選手、多筆記錄，全部拆開成陣列
- distance 是公尺數字（如 10米 → 10），seconds 是秒數（如 2.1秒 → 2.1）
- 完全解析不到就回 []`;
  try {
    const res = await model.generateContent(prompt);
    const t = res.response.text();
    const match = t.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(r => r && r.name && +r.distance > 0 && +r.seconds > 0)
      .map(r => ({ name: String(r.name).trim(), distance: Math.round(+r.distance), seconds: +r.seconds }));
  } catch (err) {
    console.error('[bike-parse] gemini error:', err.message);
    return [];
  }
}

/** 主入口：規則優先，失敗才 Gemini */
export async function parseRecords(text) {
  const r = parseRecordsRegex(text);
  if (r.length) return r;
  return await parseRecordsGemini(text);
}
