/**
 * 小帥的群組收藏連結：每群各自一份，依分類存（運動、美食、旅遊…）
 *
 * 只存「觸發訊息原文裡真的有」的網址（AI 給的網址必須對得上原文，不能自己編）；
 * 標題用 safeFetch 抓網頁預覽（防 SSRF），抓不到就用網域名稱。
 */

import { safeFetch } from '../../src/utils/safe-fetch.js';

const MAX_PER_CHAT = 500;
const LIST_MAX = 15;
const URL_RE = /https?:\/\/[^\s<>"'，。、）)]+/gi;
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

let db = null;

export function initLinks(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL DEFAULT '',
      added_by_id TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_links_chat ON links(chat_id, category);
  `);
}

export const urlsIn = (text) => [...String(text || '').matchAll(URL_RE)].map(m => m[0]);

const clean = (s, max) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max);

export function normCategory(c) {
  const s = clean(c, 10).replace(/[用類的]$/, '');
  return s || '其他';
}

const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

async function fetchTitle(url) {
  try {
    const { text } = await safeFetch(url, { headers: { 'User-Agent': PREVIEW_UA }, timeoutMs: 5000, maxBytes: 600_000 });
    const raw = text.match(/(?:property|name)="og:title"[^>]*content="([^"]*)"/)?.[1]
      || text.match(/content="([^"]*)"[^>]*(?:property|name)="og:title"/)?.[1]
      || text.match(/<title[^>]*>([^<]*)</)?.[1] || '';
    // FB 的 og:title 前面是「13 萬次觀看 · 1 萬個心情 |」，去掉；只留第一行
    const t = decode(raw).replace(/^[\d.,\s萬千]+次觀看[^|]*\|\s*/, '').split('\n')[0];
    const title = clean(t, 60);
    if (title && !/^(facebook|instagram|log in|登入)$/i.test(title)) return title;
  } catch { /* 抓不到就用網域 */ }
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '連結'; }
}

/**
 * 存一筆。url 必須出現在 sourceText 裡（AI 給的網址對不上原文就不存）
 * @returns {{ ok: boolean, id?: number, title?: string, category?: string, dup?: boolean, error?: string }}
 */
export async function saveLink(chatId, { url, category, note, sourceText, by, byId }) {
  const inText = urlsIn(sourceText);
  if (!inText.length) return { ok: false, error: '訊息裡沒有網址' };
  const picked = inText.includes(url) ? url : (inText.length === 1 ? inText[0] : null);
  if (!picked) return { ok: false, error: '不確定要存哪一個網址' };
  const cat = normCategory(category);
  const dup = db.get('SELECT id, category, title FROM links WHERE chat_id = ? AND url = ?', chatId, picked);
  if (dup) return { ok: true, dup: true, id: dup.id, category: dup.category, title: dup.title };
  const count = db.get('SELECT COUNT(*) AS c FROM links WHERE chat_id = ?', chatId).c;
  if (count >= MAX_PER_CHAT) return { ok: false, error: `這個群已經存了 ${MAX_PER_CHAT} 筆，先刪掉一些` };
  const title = await fetchTitle(picked);
  const r = db.run('INSERT INTO links (chat_id, url, category, title, note, added_by, added_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    chatId, picked, cat, title, clean(note, 60), clean(by, 30), clean(byId, 64));
  return { ok: true, id: Number(r.lastInsertRowid), category: cat, title };
}

export function categories(chatId) {
  return db.all('SELECT category, COUNT(*) AS n FROM links WHERE chat_id = ? GROUP BY category ORDER BY MAX(id) DESC', chatId);
}

/** 給 LINE 看的清單文字 */
export function listText(chatId, category) {
  const cats = categories(chatId);
  if (!cats.length) return '這個群還沒收藏任何連結\n存法：/小帥 存 運動 <網址>，或叫小帥「幫我記錄運動用 <網址>」';
  const cat = category ? normCategory(category) : '';
  if (!cat) {
    return ['🔖 這個群的收藏', ...cats.map(c => `・${c.category}（${c.n}）`), '', '看某一類：/小帥 收藏 運動'].join('\n');
  }
  const rows = db.all('SELECT id, url, title, note FROM links WHERE chat_id = ? AND category = ? ORDER BY id DESC LIMIT ?', chatId, cat, LIST_MAX);
  if (!rows.length) return `「${cat}」還沒有收藏\n現有分類：${cats.map(c => c.category).join('、')}`;
  const total = cats.find(c => c.category === cat)?.n || rows.length;
  const lines = [`🔖 ${cat}（共 ${total}${total > LIST_MAX ? `，顯示最新 ${LIST_MAX}` : ''}）`];
  for (const r of rows) lines.push(`#${r.id} ${r.title}${r.note ? `｜${r.note}` : ''}`, r.url);
  lines.push('', '刪除：/小帥 收藏 刪 #編號');
  return lines.join('\n');
}

/** 刪除：存的人或管理員才能刪 */
export function removeLink(chatId, id, userId, isAdmin) {
  const r = db.get('SELECT id, title, added_by_id FROM links WHERE chat_id = ? AND id = ?', chatId, Number(id));
  if (!r) return `找不到 #${id}`;
  if (r.added_by_id && r.added_by_id !== userId && !isAdmin) return '只有存的人或管理員能刪';
  db.run('DELETE FROM links WHERE id = ?', r.id);
  return `🗑️ 已刪除 #${r.id} ${r.title}`;
}
