/**
 * 從 AI 回覆裡取出 JSON 物件（2026-10-28）
 *
 * AI 被要求「只輸出一個 JSON」，但偶爾會：先講一段話再接 JSON、JSON 被截斷沒收尾、JSON 後面又多寫東西。
 * 之前的解析在這些情況會把整段原文（含 {"reply":... ）直接當回覆送給使用者。這裡保證：
 *   - 能找到完整的 JSON 物件就用它（略過前後的文字、字串裡的括號）
 *   - 找不到完整的：從殘缺的 JSON 救回 "reply" 的字串值
 *   - 再救不到：只用 JSON 開始前的文字
 *   - 絕不回傳含 JSON 原文的文字
 */

/** 從 s[i] 的 { 開始找配對的 }（字串裡的括號、跳脫字元不算），找不到回 -1 */
function matchBrace(s, i) {
  let depth = 0;
  let inStr = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

/** 第一個能 parse 成物件的 JSON；沒有回 null */
export function extractJson(raw) {
  const s = String(raw || '');
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = matchBrace(s, i);
    if (end < 0) continue;
    try {
      const o = JSON.parse(s.slice(i, end + 1));
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch { /* 試下一個 { */ }
  }
  return null;
}

/** 殘缺 JSON 裡 "key": "…" 的字串值（截斷的就取到斷掉的地方）；沒有回 '' */
export function salvageString(raw, key = 'reply') {
  const s = String(raw || '');
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(s);
  if (!m) return '';
  let out = '';
  for (let k = m.index + m[0].length; k < s.length; k++) {
    const c = s[k];
    if (c === '"') break;
    if (c !== '\\') { out += c; continue; }
    const n = s[++k];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = s.slice(k + 1, k + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      k += 4;
    } else out += { n: '\n', t: '\t', r: '', b: '', f: '' }[n] ?? n;
  }
  return out.trim();
}

/** JSON（{" 開頭）之前的文字 */
export function proseBefore(raw) {
  const s = String(raw || '');
  const m = /\{\s*"/.exec(s);
  return (m ? s.slice(0, m.index) : s).replace(/```(json)?\s*$/i, '').trim();
}

/**
 * @returns {{ obj: object|null, text: string }} obj：完整 JSON；text：沒有完整 JSON 時能給人看的文字（救回的 reply 或 JSON 前的話）
 */
export function parseLlmJson(raw) {
  const obj = extractJson(raw);
  if (obj) return { obj, text: '' };
  return { obj: null, text: salvageString(raw, 'reply') || proseBefore(raw) };
}
