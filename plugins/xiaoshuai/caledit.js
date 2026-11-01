/**
 * 行事曆網頁上直接改（2026-11-01，照 共用/AI產出/mockup/小帥月曆兩週＋編輯預覽.html）
 *
 * 誰能改：從 LINE 用 LIFF 打開，主機拿 ID token 向 LINE 驗身分（不信網頁傳的 userId），而且要是那個群的成員；
 *   只有網址的人只能看。LIFF ID／Channel ID 沒設定時整個編輯功能關著，網頁不出現「改」
 * 能改什麼：自己記的事（標題、短名稱、日期、時間、地點、參加的人、刪除）；旅遊行程讀進來的只能改短名稱和參加的人
 *   （存 cal_trip_edits，行程網頁還是正本）。只能改這個網頁那個聊天的資料
 * 手動改過的欄位記在 manual（{"l":1,"who":1…}），AI 重算不蓋；參加的人存成「@Uxxx」，直接對到成員
 * 紀錄：新增、修改、刪除、還原、家庭對應、設定都記 cal_history（誰、什麼時間、哪一欄、從什麼改成什麼）；刪除是軟刪除，可以還原
 * 兩個人同時改：每筆有版本號，送出時版本不對回 409＋最後一次是誰改了什麼，網頁問要不要蓋掉
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import * as cards from './cards.js';
import * as meta from './calmeta.js';

let db = null;
const KEEP_DELETED_MS = 90 * 86400_000;  // 軟刪除的留 90 天
const KEEP_HISTORY_MS = 400 * 86400_000;
export const FIELDS = { n: '完整標題', l: '短名稱', d: '日期', t: '時間', p: '地點', who: '參加的人' };

export function initEdit(database, now = Date.now()) {
  db = database;
  const cols = db.all('PRAGMA table_info(cal_events)').map(c => c.name);
  if (!cols.includes('manual')) db.exec('ALTER TABLE cal_events ADD COLUMN manual TEXT');
  if (!cols.includes('deleted_at')) db.exec('ALTER TABLE cal_events ADD COLUMN deleted_at INTEGER');
  if (!cols.includes('version')) db.exec('ALTER TABLE cal_events ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cal_trip_edits (
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      day TEXT NOT NULL,
      short TEXT,
      who TEXT,
      manual TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, name, day)
    );
    CREATE TABLE IF NOT EXISTS cal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      what TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cal_history ON cal_history(chat_id, ref, id);
    CREATE TABLE IF NOT EXISTS cal_settings (
      chat_id TEXT PRIMARY KEY,
      notify INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run('DELETE FROM cal_events WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - KEEP_DELETED_MS);
  db.run('DELETE FROM cal_history WHERE at < ?', now - KEEP_HISTORY_MS);
}

export const parseManual = (s) => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// ── 紀錄 ──────────────────────────────────────────

/** 記一筆；by = { id, name }（小帥在聊天裡改的也記，name 是 LINE 暱稱） */
export function log(chatId, ref, by, what, now = Date.now()) {
  db?.run('INSERT INTO cal_history (chat_id, ref, user_id, user_name, at, what) VALUES (?, ?, ?, ?, ?, ?)',
    chatId, ref, by?.id || '', cards.clean(by?.name, 30), now, cards.clean(what, 200));
}
export const history = (chatId, ref, limit = 30) => db.all('SELECT * FROM cal_history WHERE chat_id = ? AND ref = ? ORDER BY id DESC LIMIT ?', chatId, ref, limit);
const lastOf = (chatId, ref) => db.get('SELECT * FROM cal_history WHERE chat_id = ? AND ref = ? ORDER BY id DESC LIMIT 1', chatId, ref);

// ── 參加的人（手動）：存「@Uxxx」，畫面上給的是成員的編號（cal_members.rowid） ──

export function whoFromKeys(chatId, keys) {
  const ids = [];
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 60)) {
    const m = db.get('SELECT user_id FROM cal_members WHERE chat_id = ? AND rowid = ? AND gone = 0', chatId, Number(k));
    if (m && !ids.includes(m.user_id)) ids.push(m.user_id);
  }
  return ids.map(u => `@${u}`);
}
const whoText = (chatId, tokens) => {
  const ids = meta.resolveWho(chatId, tokens);
  const all = meta.members(chatId);
  if (all.length && all.every(m => ids.includes(m.user_id))) return '全員';
  return ids.map(u => all.find(m => m.user_id === u)?.name || '某人').join('、') || '沒有';
};

/** 兩組稱呼對到的成員一樣嗎（「妞家」跟「@U葶」算一樣） */
const sameWho = (chatId, a, b) => [...meta.resolveWho(chatId, a)].sort().join() === [...meta.resolveWho(chatId, b)].sort().join();

// ── 驗欄位 ────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDay(d) {
  if (!DAY_RE.test(d || '')) return false;
  const [y, m, dd] = d.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === dd && y >= 2020 && y <= 2100;
}
/** 網頁送來的修改 → 乾淨的欄位值；不對回 { error } */
export function cleanChanges(chatId, ch, { trip = false } = {}) {
  const out = {};
  if (!ch || typeof ch !== 'object') return { error: '沒有要改的' };
  for (const k of Object.keys(ch)) {
    if (!(k in FIELDS)) continue;
    if (trip && !['l', 'who'].includes(k)) return { error: '旅遊行程的標題、日期、時間、地點要回行程網頁改' };
    const v = ch[k];
    if (k === 'n') { const s = cards.clean(v, 30); if (!s) return { error: '標題不能空白' }; out.n = s; }
    if (k === 'l') { const s = [...cards.clean(String(v || ''), 12).replace(/\s+/g, '')].slice(0, 6).join(''); if (!s) return { error: '短名稱不能空白' }; out.l = s; }
    if (k === 'd') { if (!validDay(v)) return { error: '日期看不懂' }; out.d = v; }
    if (k === 't') { if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { error: '時間看不懂' }; out.t = v || null; }
    if (k === 'p') out.p = cards.clean(v, 20);
    if (k === 'who') out.who = whoFromKeys(chatId, v);
  }
  return Object.keys(out).length ? { ok: out } : { error: '沒有要改的' };
}

// ── 自己記的事 ────────────────────────────────────

const conflictOf = (chatId, ref) => { const h = lastOf(chatId, ref); return h ? { by: h.user_name, at: h.at, what: h.what } : { by: '', at: 0, what: '' }; };
const COL = { n: 'title', l: 'short', d: 'day', t: 'time', p: 'place', who: 'who' };

/** 改自己記的事；version 不對且沒說要蓋 → { conflict } */
export function editEvent(chatId, id, by, changes, { version, force = false, now = Date.now() } = {}) {
  const ev = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ?', Number(id), chatId);
  if (!ev || ev.deleted_at) return { error: '這件事已經不在行事曆裡了（可能剛被刪掉）' };
  const ref = `e${ev.id}`;
  if (!force && Number(version) !== ev.version) return { conflict: conflictOf(chatId, ref), version: ev.version };
  const c = cleanChanges(chatId, changes);
  if (c.error) return c;
  const man = parseManual(ev.manual);
  const before = { n: ev.title, l: ev.short || meta.fallbackShort(ev.title), d: ev.day, t: ev.time, p: ev.place, who: parseArr(ev.who) };
  const sets = []; const args = [];
  for (const [k, v] of Object.entries(c.ok)) {
    const same = k === 'who' ? sameWho(chatId, v, before.who) : (v ?? null) === (before[k] ?? null);
    if (same) continue;
    sets.push(`${COL[k]} = ?`); args.push(k === 'who' ? JSON.stringify(v) : v);
    man[k] = 1;
    const show = (x) => (k === 'who' ? whoText(chatId, x) : k === 't' ? (x || '全天') : (x || '空白'));
    log(chatId, ref, by, `${FIELDS[k]}：${show(before[k])} → ${show(v)}`, now);
  }
  if (!sets.length) return { error: '跟原本一樣，沒有要改的' };
  db.run(`UPDATE cal_events SET ${sets.join(', ')}, manual = ?, version = version + 1, updated_at = ? WHERE id = ?`, ...args, JSON.stringify(man), now, ev.id);
  return { ok: true, event: db.get('SELECT * FROM cal_events WHERE id = ?', ev.id) };
}

/** 軟刪除（聊天裡說「刪掉」、按卡片的刪掉、網頁上刪都走這裡） */
export function softDelete(chatId, id, by, { version = null, force = false, now = Date.now() } = {}) {
  const ev = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ?', Number(id), chatId);
  if (!ev || ev.deleted_at) return { error: '這件事已經不在行事曆裡了' };
  if (version != null && !force && Number(version) !== ev.version) return { conflict: conflictOf(chatId, `e${ev.id}`), version: ev.version };
  db.run('UPDATE cal_events SET deleted_at = ?, version = version + 1 WHERE id = ?', now, ev.id);
  log(chatId, `e${ev.id}`, by, `刪除了「${ev.title}」`, now);
  return { ok: true, event: ev };
}
export function restore(chatId, id, by, now = Date.now()) {
  const ev = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ?', Number(id), chatId);
  if (!ev || !ev.deleted_at) return { error: '這件事沒有被刪掉' };
  db.run('UPDATE cal_events SET deleted_at = NULL, version = version + 1 WHERE id = ?', ev.id);
  log(chatId, `e${ev.id}`, by, `還原了「${ev.title}」`, now);
  return { ok: true, event: db.get('SELECT * FROM cal_events WHERE id = ?', ev.id) };
}
/** 最近刪除（30 天內），網頁上可以還原 */
export const deletedList = (chatId, now = Date.now()) => db.all('SELECT id, day, time, title, deleted_at FROM cal_events WHERE chat_id = ? AND deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC LIMIT 30', chatId, now - 30 * 86400_000);

// ── 旅遊行程那幾天：只改短名稱和參加的人 ──────────────

export const tripRef = (name, day) => `t|${name}|${day}`;
export function tripEdit(chatId, name, day) {
  const r = db?.get('SELECT * FROM cal_trip_edits WHERE chat_id = ? AND name = ? AND day = ?', chatId, name, day);
  return r ? { short: r.short, who: r.who ? parseArr(r.who) : null, manual: parseManual(r.manual), version: r.version } : null;
}
/** current：這天現在顯示的 { l, who }（AI 標的或行程預設），寫紀錄用 */
export function editTrip(chatId, name, day, by, changes, { version, force = false, current = {}, now = Date.now() } = {}) {
  if (!/^[a-z0-9-]{1,60}$/.test(name || '') || !validDay(day)) return { error: '找不到這天的行程' };
  const ref = tripRef(name, day);
  const cur = tripEdit(chatId, name, day) || { short: null, who: null, manual: {}, version: 0 };
  if (!force && Number(version) !== cur.version) return { conflict: conflictOf(chatId, ref), version: cur.version };
  const c = cleanChanges(chatId, changes, { trip: true });
  if (c.error) return c;
  const before = { l: cur.short ?? current.l ?? '', who: cur.who ?? current.who ?? [] };
  const man = { ...cur.manual };
  let short = cur.short; let who = cur.who; let changed = false;
  if ('l' in c.ok && c.ok.l !== before.l) { log(chatId, ref, by, `短名稱：${before.l || '空白'} → ${c.ok.l}`, now); short = c.ok.l; man.l = 1; changed = true; }
  if ('who' in c.ok && !sameWho(chatId, c.ok.who, before.who)) {
    log(chatId, ref, by, `參加的人：${whoText(chatId, before.who)} → ${whoText(chatId, c.ok.who)}`, now); who = c.ok.who; man.who = 1; changed = true;
  }
  if (!changed) return { error: '跟原本一樣，沒有要改的' };
  db.run(`INSERT INTO cal_trip_edits (chat_id, name, day, short, who, manual, version) VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(chat_id, name, day) DO UPDATE SET short = excluded.short, who = excluded.who, manual = excluded.manual, version = cal_trip_edits.version + 1`,
  chatId, name, day, short, who ? JSON.stringify(who) : null, JSON.stringify(man));
  return { ok: true, version: cur.version + 1 };
}
/** 手動改過的欄位改回自動（AI 的） */
export function unpin(chatId, ref, field, by, now = Date.now()) {
  if (!['l', 'who'].includes(field)) return { error: '只有短名稱和參加的人可以改回自動' };
  const m = /^e(\d+)$/.exec(ref);
  if (m) {
    const ev = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ? AND deleted_at IS NULL', Number(m[1]), chatId);
    if (!ev) return { error: '找不到這件事' };
    const man = parseManual(ev.manual); delete man[field];
    db.run(`UPDATE cal_events SET ${COL[field]} = NULL, manual = ?, version = version + 1 WHERE id = ?`, JSON.stringify(man), ev.id);
  } else {
    const t = /^t\|([a-z0-9-]{1,60})\|(\d{4}-\d{2}-\d{2})$/.exec(ref);
    const cur = t && tripEdit(chatId, t[1], t[2]);
    if (!cur) return { error: '找不到這天的行程' };
    const man = { ...cur.manual }; delete man[field];
    db.run(`UPDATE cal_trip_edits SET ${field === 'l' ? 'short' : 'who'} = NULL, manual = ?, version = version + 1 WHERE chat_id = ? AND name = ? AND day = ?`, JSON.stringify(man), chatId, t[1], t[2]);
  }
  log(chatId, ref, by, `${FIELDS[field]}：改回自動`, now);
  return { ok: true };
}

// ── 家庭對應、設定 ────────────────────────────────

/** 整份換掉：[{ name: '綸鈞家', keys: [成員編號…] }]，排第一位的是代表 */
export function setFamilies(chatId, list, by, now = Date.now()) {
  if (!Array.isArray(list) || list.length > 30) return { error: '家庭對應格式不對' };
  const rows = [];
  for (const f of list) {
    const fam = meta.baseOf(cards.clean(f?.name, 12));
    if (!fam || [...fam].length > 8) return { error: `「${cards.clean(f?.name, 12)}」這個名稱不行` };
    if (rows.some(r => r.fam === fam)) return { error: `「${fam}家」重複了` };
    rows.push({ fam, ids: whoFromKeys(chatId, f.keys).map(x => x.slice(1)) });
  }
  const before = meta.families(chatId).map(f => `${f.family}家`).join('、');
  db.run('DELETE FROM cal_families WHERE chat_id = ?', chatId);
  for (const r of rows) db.run('INSERT INTO cal_families (chat_id, family, user_ids, updated_at) VALUES (?, ?, ?, ?)', chatId, r.fam, JSON.stringify(r.ids), now);
  const name = (u) => meta.members(chatId).find(m => m.user_id === u)?.name || '某人';
  log(chatId, 'fam', by, `家庭對應：${rows.map(r => `${r.fam}家＝${r.ids.map(name).join('、') || '（沒人）'}`).join('；') || '清空'}（原本：${before || '沒有'}）`, now);
  return { ok: true };
}
export const notifyOn = (chatId) => !!db?.get('SELECT notify FROM cal_settings WHERE chat_id = ?', chatId)?.notify;
export function setNotify(chatId, on, by, now = Date.now()) {
  db.run('INSERT INTO cal_settings (chat_id, notify) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET notify = excluded.notify', chatId, on ? 1 : 0);
  log(chatId, 'set', by, `有人改了要不要在群組說一聲：${on ? '要' : '不要'}`, now);
  return { ok: true };
}

// ── LIFF（LINE 網頁登入）設定與驗身分 ─────────────────

const LIFF_ID_RE = /^\d{10}-[A-Za-z0-9]{8}$/;
let cfgCache = { at: 0, mtime: 0, v: null };
/** 環境變數 XIAOSHUAI_LIFF_ID／XIAOSHUAI_LIFF_CHANNEL_ID，沒有就讀 data/xiaoshuai-liff.json（{ liffId, channelId }，都不是密碼）；沒設定回 null */
export function liffConfig(file = process.env.XIAOSHUAI_LIFF_FILE) {
  let liffId = process.env.XIAOSHUAI_LIFF_ID || '';
  let channelId = process.env.XIAOSHUAI_LIFF_CHANNEL_ID || '';
  if ((!liffId || !channelId) && file && existsSync(file)) {
    try {
      const mt = statSync(file).mtimeMs;
      if (mt !== cfgCache.mtime) cfgCache = { at: Date.now(), mtime: mt, v: JSON.parse(readFileSync(file, 'utf8')) };
      liffId ||= String(cfgCache.v?.liffId || '');
      channelId ||= String(cfgCache.v?.channelId || '');
    } catch { /* 格式不對就當沒設定 */ }
  }
  return LIFF_ID_RE.test(liffId) && /^\d{10}$/.test(channelId) ? { liffId, channelId } : null;
}

/**
 * 向 LINE 驗 ID token（https://api.line.me/oauth2/v2.1/verify），回 { userId, name } 或 null
 * 只信 LINE 回的 sub；client_id 要是我們的 LINE Login channel（別的 app 的 token 不收）
 */
const verified = new Map(); // token → { v, exp }
let verifier = null;
/** 測試用：換掉向 LINE 驗的那一段 */
export const setVerifier = (fn) => { verifier = fn; verified.clear(); };
export const verify = (idToken, channelId) => (verifier ? verifier(idToken, channelId) : verifyIdToken(idToken, channelId));
export async function verifyIdToken(idToken, channelId, { fetchFn = fetch, now = Date.now() } = {}) {
  const tok = String(idToken || '');
  if (!tok || tok.length > 4000 || !channelId) return null;
  const c = verified.get(tok);
  if (c && c.exp > now) return c.v;
  try {
    const res = await fetchFn('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: tok, client_id: channelId }).toString() });
    if (!res.ok) return null;
    const j = await res.json();
    if (!/^U[0-9a-f]{32}$/.test(j?.sub || '') || String(j.aud) !== String(channelId) || !(j.exp * 1000 > now)) return null;
    const v = { userId: j.sub, name: cards.clean(j.name, 30) };
    if (verified.size > 500) verified.clear();
    verified.set(tok, { v, exp: Math.min(j.exp * 1000, now + 10 * 60_000) });
    return v;
  } catch { return null; }
}
