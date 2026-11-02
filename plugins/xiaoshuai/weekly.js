/**
 * 小帥學習週報（2026-11-02）：每週日 20:00 把拼字塔的學習排行（分數＋完成度）、奧數挑戰榜整理成一則，
 * 排進「下一個人講話時貼」的免費回覆（不推播、不扣額度）。哪些群要收：群裡管理員打 /小帥 週報 開。
 * 結尾一句鼓勵：跟上一次週報比，點名分數進步最多的人；第一次或沒人進步就鼓勵第一名。
 */

import { safeText as txt, safeNum as num } from './learning.js';

export const WEEKLY_CRON = '0 20 * * 0';          // 週日 20:00（台北）
export const WEEKLY_KEEP_MS = 3 * 86400_000;      // 排著等人講話，最多等到週三晚上
const MAX_ROWS = 8;

let db = null;

export function initWeekly(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_report (
      chat_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      scores TEXT,
      sent_at INTEGER
    )
  `);
}

export function setWeekly(chatId, on) {
  db.run(`INSERT INTO weekly_report (chat_id, enabled) VALUES (?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled`, chatId, on ? 1 : 0);
}
export function weeklyOn(chatId) {
  return !!db?.get('SELECT enabled FROM weekly_report WHERE chat_id = ?', chatId)?.enabled;
}
export function subscribers() {
  return db ? db.all('SELECT chat_id FROM weekly_report WHERE enabled = 1').map(r => r.chat_id) : [];
}
/** 上一次週報時各人的分數 { 名字: 分數 }，沒有回 null */
export function lastScores(chatId) {
  const raw = db?.get('SELECT scores FROM weekly_report WHERE chat_id = ?', chatId)?.scores;
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function saveScores(chatId, scores, now = Date.now()) {
  db.run('UPDATE weekly_report SET scores = ?, sent_at = ? WHERE chat_id = ?', JSON.stringify(scores), now, chatId);
}

/** 這次週報要記下來的分數（下次比進步用） */
export function scoresOf(data) {
  const out = {};
  for (const r of data?.leaderboard?.kids || []) if (Number.isFinite(+r.score)) out[txt(r.name)] = +r.score;
  return out;
}

const MEDAL = ['🥇', '🥈', '🥉'];
const place = (i) => MEDAL[i] || `${i + 1}.`;
const mmdd = (now) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }).format(now);

/** 鼓勵的話：有上次的分數就點名進步最多的，否則鼓勵第一名 */
export function cheer(kids, prev) {
  if (!kids.length) return '';
  if (prev) {
    let best = null;
    for (const r of kids) {
      const name = txt(r.name);
      if (!(name in prev) || !Number.isFinite(+r.score)) continue;
      const gain = +r.score - prev[name];
      if (gain > 0 && (!best || gain > best.gain)) best = { name, gain };
    }
    if (best) return `🐶 這週進步最多的是 ${best.name}，多了 ${best.gain} 分，太帥了！下週大家一起衝～`;
  }
  return `🐶 ${txt(kids[0].name)} 第一名繼續保持！其他人下週加油，小帥幫你們加油～`;
}

/** 整理成週報文字；data 是大廳 /api/internal/learning 的回傳 */
export function weeklyText(data, prev = null, now = Date.now()) {
  if (!data) return '';
  const kids = data.leaderboard?.kids || [];
  const ch = (data.challenge?.kids || []).filter(r => +r.score > 0);
  const lines = [`📊 小帥學習週報（${mmdd(now)}）`, '', '〔學習排行〕'];
  if (kids.length) lines.push(...kids.slice(0, MAX_ROWS).map((r, i) => `${place(i)} ${txt(r.name)} ${num(r.score)} 分・完成度 ${num(r.pct)}%`));
  else lines.push('這週還沒有人上榜');
  if (ch.length) {
    lines.push('', '〔奧數挑戰榜〕');
    lines.push(...ch.slice(0, MAX_ROWS).map((r, i) => `${place(i)} ${txt(r.name)} ${num(r.score)} 分`));
  }
  const c = cheer(kids, prev);
  if (c) lines.push('', c);
  return lines.join('\n').slice(0, 2000);
}
