/**
 * 小帥讀孩子們的學習資料（遊戲大廳 web-hub 的拼字塔）：學習排行、奧數挑戰榜、全員進度總覽
 *
 * 資料來源：同一台 Mac 的大廳 /api/internal/learning/<網站>（只收本機直連、唯讀、白名單輸出）。
 * 只有這句話跟學習有關才去讀、才放進給 AI 的資料（2026-10-26 使用者決定所有開了小帥的群都能問）。
 */

const HUB = (process.env.HUB_URL || 'http://127.0.0.1:4800').replace(/\/$/, '');
const SITE = 'pinzi';
const CACHE_MS = 60_000;

let cache = { at: 0, data: null };

const LEARNING_RE = /排名|排行|名次|第一名|分數|積分|學習|拼字塔|奧數|挑戰榜|進度|練習|練了|有練|沒練|複習|今日任務|今天的任務|功課|國語|數學|自然|社會|英語|誰.*(最高|最多|最厲害|還沒)/;
export const aboutLearning = (text) => LEARNING_RE.test(String(text || ''));

export async function fetchLearning() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    // 自訂標頭＋本機 Host：大廳用來擋瀏覽器 DNS rebinding
    const res = await fetch(`${HUB}/api/internal/learning/${SITE}`, { headers: { 'x-hub-internal': 'linebot' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = { at: Date.now(), data: await res.json() };
    return cache.data;
  } catch (err) {
    console.warn(`[xiaoshuai-learning] 讀不到學習資料：${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const GRADE = ['', '一', '二', '三', '四', '五', '六'];
// 存檔欄位是孩子端網頁寫的，當作不可信文字：去換行、去標記符號、限長
const txt = (v, max = 30) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[【】<>〔〕]/g, '').trim().slice(0, max);
const num = (v) => (v !== undefined && v !== null && Number.isFinite(+v) ? +v : '—');
const ago = (ts, now) => {
  if (!ts) return '沒有紀錄';
  const m = Math.round((now - ts) / 60_000);
  if (m < 60) return `${Math.max(m, 1)} 分鐘前`;
  if (m < 24 * 60) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 天前`;
};

/** 整理成給 AI 看的精簡文字 */
export function learningText(data, now = Date.now()) {
  if (!data) return '';
  const lines = [];
  const lb = data.leaderboard || {};
  const board = (list, fmt) => (list?.length ? list.map((r, i) => `${i + 1}. ${fmt(r)}`) : ['（沒有人）']);
  lines.push('〔學習排行〕分數＝課程完成度基本分＋星星分');
  lines.push(...board(lb.kids, r => `${txt(r.name)} ${num(r.score)} 分（完成度 ${num(r.pct)}%${r.starPts !== undefined ? `，星星分 ${num(r.starPts)}` : ''}）`));
  if (lb.adults?.length) lines.push('大人榜：', ...board(lb.adults, r => `${txt(r.name)} ${num(r.score)} 分（完成度 ${num(r.pct)}%）`));
  const ch = data.challenge || {};
  lines.push('〔奧數挑戰榜〕入門／進階／挑戰三級分數加總');
  lines.push(...board(ch.kids, r => `${txt(r.name)} ${num(r.score)} 分（入門 ${num(r.lv?.[0])}、進階 ${num(r.lv?.[1])}、挑戰 ${num(r.lv?.[2])}）`));
  const ov = data.overview || {};
  lines.push(`〔每個人的進度〕今天是 ${txt(ov.today, 12)}`);
  for (const k of [...(ov.kids || []), ...(ov.adults || [])].slice(0, 20)) {
    const days = (Array.isArray(k.week) ? k.week : []).filter(Boolean).length;
    const subj = (k.subjects || []).slice(0, 8).map(s => `${txt(s.name, 6)} ${num(s.learned)}/${num(s.total)}`).join('、');
    const daily = (k.daily || []).slice(0, 6).map(d => `${txt(d.s, 6)}${txt(d.label)}${d.ok ? '✓' : '✗'}`).join('、');
    const rev = (k.reviews || []).slice(0, 3).map(r => `${txt(r.s, 6)}「${txt(r.title)}」`).join('、');
    const grade = Number.isInteger(k.grade) ? `（${GRADE[k.grade] || k.grade}年級${txt(k.term, 6)}）` : '';
    lines.push(`・${txt(k.name)}${grade}：最近練習 ${ago(k.lastAt, now)}；近 7 天練了 ${days} 天${k.score !== undefined ? `；${num(k.score)} 分` : ''}`);
    if (subj) lines.push(`  學會單元：${subj}`);
    if (daily) lines.push(`  今日任務：${daily}`);
    if (rev) lines.push(`  待複習：${rev}${(k.reviews || []).length > 3 ? ` 等 ${(k.reviews || []).length} 個` : ''}`);
  }
  return lines.join('\n').slice(0, 4000);
}
