/**
 * 行事曆網頁上直接改（2026-11-01，照 共用/AI產出/mockup/小帥月曆兩週＋編輯預覽.html）
 *
 * 誰能改（2026-11-01 改成先開放免登入）：
 *   ①編輯連結：群組卡片的「看整個月」網址帶 #k=<編輯碼>（192 bit，放 fragment 不會進 Referer／主機 log），碼對才能改那個聊天；
 *     打開時從成員裡選「我是誰」（自報身分，紀錄上標「自報」並存裝置指紋的雜湊，不存 IP 明文）。「行事曆 換網址」重發碼、舊的立刻失效
 *   ②LIFF（LINE 登入）：有設定 LIFF 時，主機拿 ID token 向 LINE 驗身分、確認是群組成員；這條路的紀錄是驗證過的身分
 * 防亂改：頻率限制（每個編輯碼、每個 IP 各算）、10 分鐘內刪 5 筆以上自動停用編輯碼 1 小時並通知 TED、
 *   欄位長度與日期範圍、不收 HTML、參加的人只能是這個群的成員；每次修改都存改之前的樣子（snap），TED 可以一鍵還原到某個時間點
 * 能改什麼：自己記的事（標題、短名稱、日期、時間、地點、參加的人、刪除）；旅遊行程讀進來的只能改短名稱和參加的人
 *   （存 cal_trip_edits，行程網頁還是正本）。只能改這個網頁那個聊天的資料
 * 手動改過的欄位記在 manual（{"l":1,"who":1…}），AI 重算不蓋；參加的人存成「@Uxxx」，直接對到成員
 * 紀錄：新增、修改、刪除、還原、家庭對應、設定都記 cal_history（誰、什麼時間、哪一欄、從什麼改成什麼）；刪除是軟刪除，可以還原
 * 兩個人同時改：每筆有版本號，送出時版本不對回 409＋最後一次是誰改了什麼，網頁問要不要蓋掉
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
    CREATE TABLE IF NOT EXISTS cal_anomaly (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      iph TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS cal_kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  // 修改紀錄：怎麼改的（chat＝LINE 聊天裡／liff＝LINE 登入／key＝編輯連結自報）、裝置指紋與 IP 的雜湊、改之前的樣子
  const hc = db.all('PRAGMA table_info(cal_history)').map(c => c.name);
  for (const [c, def] of [['via', "TEXT NOT NULL DEFAULT 'chat'"], ['fp', "TEXT NOT NULL DEFAULT ''"], ['iph', "TEXT NOT NULL DEFAULT ''"], ['snap', 'TEXT']]) {
    if (!hc.includes(c)) db.exec(`ALTER TABLE cal_history ADD COLUMN ${c} ${def}`);
  }
  const pc = db.all('PRAGMA table_info(cal_pages)').map(c => c.name);
  if (!pc.includes('edit_key')) db.exec('ALTER TABLE cal_pages ADD COLUMN edit_key TEXT');
  if (!pc.includes('key_at')) db.exec('ALTER TABLE cal_pages ADD COLUMN key_at INTEGER NOT NULL DEFAULT 0');
  if (!pc.includes('suspended_until')) db.exec('ALTER TABLE cal_pages ADD COLUMN suspended_until INTEGER NOT NULL DEFAULT 0');
  db.run('DELETE FROM cal_anomaly WHERE at < ?', now - KEEP_HISTORY_MS);
  db.run('DELETE FROM cal_events WHERE deleted_at IS NOT NULL AND deleted_at < ?', now - KEEP_DELETED_MS);
  db.run('DELETE FROM cal_history WHERE at < ?', now - KEEP_HISTORY_MS);
}

export const parseManual = (s) => { try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// ── 紀錄 ──────────────────────────────────────────

/**
 * 記一筆；by = { id, name, via, fp, iph }（via：chat／liff／key；key 是自報身分）
 * snap：改之前的樣子（還原到某個時間點用），一次修改只在第一行帶
 */
export function log(chatId, ref, by, what, now = Date.now(), snap = undefined) {
  db?.run('INSERT INTO cal_history (chat_id, ref, user_id, user_name, at, what, via, fp, iph, snap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    chatId, ref, by?.id || '', cards.clean(by?.name, 30), now, cards.clean(what, 200), by?.via || 'chat', by?.fp || '', by?.iph || '', snap === undefined ? null : JSON.stringify(snap));
}
const SNAP_COLS = ['title', 'short', 'day', 'time', 'place', 'who', 'manual', 'deleted_at'];
export const snapEvent = (ev) => (ev ? Object.fromEntries(SNAP_COLS.map(c => [c, ev[c] ?? null])) : { _new: 1 });
const snapTrip = (chatId, name, day) => db.get('SELECT short, who, manual FROM cal_trip_edits WHERE chat_id = ? AND name = ? AND day = ?', chatId, name, day) || { _none: 1 };
const snapFam = (chatId) => db.all('SELECT family, user_ids FROM cal_families WHERE chat_id = ? ORDER BY rowid', chatId);
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

export const LIMITS = { n: 60, l: 8, p: 60, years: 2 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTML_RE = /[<>]/;
/** 日期合法、而且在今天前後 2 年內 */
function validDay(d, now = Date.now()) {
  if (!DAY_RE.test(d || '')) return false;
  const [y, m, dd] = d.split('-').map(Number);
  const x = Date.UTC(y, m - 1, dd);
  const back = new Date(x);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== dd) return false;
  return Math.abs(x - now) <= LIMITS.years * 366 * 86400_000;
}
/** 文字欄位：不收 HTML 符號、超過長度就擋（不默默截斷） */
function text(v, max, name) {
  const raw = String(v ?? '').normalize('NFKC').trim();
  if (HTML_RE.test(raw)) return { error: `${name}不能有 < > 符號` };
  if ([...raw].length > max) return { error: `${name}最多 ${max} 個字` };
  return { ok: cards.clean(raw, max) };
}
/** 網頁送來的修改 → 乾淨的欄位值；不對回 { error } */
export function cleanChanges(chatId, ch, { trip = false, now = Date.now() } = {}) {
  const out = {};
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return { error: '沒有要改的' };
  for (const k of Object.keys(ch)) {
    if (!(k in FIELDS)) continue;
    if (trip && !['l', 'who'].includes(k)) return { error: '旅遊行程的標題、日期、時間、地點要回行程網頁改' };
    const v = ch[k];
    if (k === 'n') { const r = text(v, LIMITS.n, '標題'); if (r.error) return r; if (!r.ok) return { error: '標題不能空白' }; out.n = r.ok; }
    if (k === 'l') { const r = text(String(v ?? '').replace(/\s+/g, ''), LIMITS.l, '短名稱'); if (r.error) return r; if (!r.ok) return { error: '短名稱不能空白' }; out.l = r.ok; }
    if (k === 'd') { if (typeof v !== 'string' || !validDay(v, now)) return { error: `日期看不懂，或離今天超過 ${LIMITS.years} 年` }; out.d = v; }
    if (k === 't') { if (v && (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))) return { error: '時間看不懂' }; out.t = v || null; }
    if (k === 'p') { const r = text(v, LIMITS.p, '地點'); if (r.error) return r; out.p = r.ok; }
    if (k === 'who') {
      // 只能是這個群的成員（編號對不到的直接擋，不默默略過）
      if (!Array.isArray(v) || v.length > 60) return { error: '參加的人格式不對' };
      const w = whoFromKeys(chatId, v);
      if (w.length !== new Set(v.map(Number)).size) return { error: '參加的人只能選這個群組的成員' };
      out.who = w;
    }
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
  const c = cleanChanges(chatId, changes, { now });
  if (c.error) return c;
  const man = parseManual(ev.manual);
  let snap = snapEvent(ev);
  const before = { n: ev.title, l: ev.short || meta.fallbackShort(ev.title), d: ev.day, t: ev.time, p: ev.place, who: parseArr(ev.who) };
  const sets = []; const args = [];
  for (const [k, v] of Object.entries(c.ok)) {
    const same = k === 'who' ? sameWho(chatId, v, before.who) : (v ?? null) === (before[k] ?? null);
    if (same) continue;
    sets.push(`${COL[k]} = ?`); args.push(k === 'who' ? JSON.stringify(v) : v);
    man[k] = 1;
    const show = (x) => (k === 'who' ? whoText(chatId, x) : k === 't' ? (x || '全天') : (x || '空白'));
    log(chatId, ref, by, `${FIELDS[k]}：${show(before[k])} → ${show(v)}`, now, snap);
    snap = undefined;
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
  log(chatId, `e${ev.id}`, by, `刪除了「${ev.title}」`, now, snapEvent(ev));
  return { ok: true, event: ev };
}
export function restore(chatId, id, by, now = Date.now()) {
  const ev = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ?', Number(id), chatId);
  if (!ev || !ev.deleted_at) return { error: '這件事沒有被刪掉' };
  db.run('UPDATE cal_events SET deleted_at = NULL, version = version + 1 WHERE id = ?', ev.id);
  log(chatId, `e${ev.id}`, by, `還原了「${ev.title}」`, now, snapEvent(ev));
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
  if (!/^[a-z0-9-]{1,60}$/.test(name || '') || !DAY_RE.test(day || '')) return { error: '找不到這天的行程' };
  const ref = tripRef(name, day);
  const cur = tripEdit(chatId, name, day) || { short: null, who: null, manual: {}, version: 0 };
  if (!force && Number(version) !== cur.version) return { conflict: conflictOf(chatId, ref), version: cur.version };
  const c = cleanChanges(chatId, changes, { trip: true, now });
  if (c.error) return c;
  const before = { l: cur.short ?? current.l ?? '', who: cur.who ?? current.who ?? [] };
  let snap = snapTrip(chatId, name, day);
  const tlog = (what) => { log(chatId, ref, by, what, now, snap); snap = undefined; };
  const man = { ...cur.manual };
  let short = cur.short; let who = cur.who; let changed = false;
  if ('l' in c.ok && c.ok.l !== before.l) { tlog(`短名稱：${before.l || '空白'} → ${c.ok.l}`); short = c.ok.l; man.l = 1; changed = true; }
  if ('who' in c.ok && !sameWho(chatId, c.ok.who, before.who)) {
    tlog(`參加的人：${whoText(chatId, before.who)} → ${whoText(chatId, c.ok.who)}`); who = c.ok.who; man.who = 1; changed = true;
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
    log(chatId, ref, by, `${FIELDS[field]}：改回自動`, now, snapEvent(ev));
    db.run(`UPDATE cal_events SET ${COL[field]} = NULL, manual = ?, version = version + 1 WHERE id = ?`, JSON.stringify(man), ev.id);
  } else {
    const t = /^t\|([a-z0-9-]{1,60})\|(\d{4}-\d{2}-\d{2})$/.exec(ref);
    const cur = t && tripEdit(chatId, t[1], t[2]);
    if (!cur) return { error: '找不到這天的行程' };
    const man = { ...cur.manual }; delete man[field];
    log(chatId, ref, by, `${FIELDS[field]}：改回自動`, now, snapTrip(chatId, t[1], t[2]));
    db.run(`UPDATE cal_trip_edits SET ${field === 'l' ? 'short' : 'who'} = NULL, manual = ?, version = version + 1 WHERE chat_id = ? AND name = ? AND day = ?`, JSON.stringify(man), chatId, t[1], t[2]);
  }
  return { ok: true };
}

// ── 家庭對應、設定 ────────────────────────────────

/** 整份換掉：[{ name: '綸鈞家', keys: [成員編號…] }]，排第一位的是代表 */
export function setFamilies(chatId, list, by, now = Date.now()) {
  if (!Array.isArray(list) || list.length > 30) return { error: '家庭對應格式不對' };
  const rows = [];
  for (const f of list) {
    if (typeof f?.name !== 'string' || HTML_RE.test(f.name) || [...f.name].length > 12) return { error: '家的名稱最多 12 個字、不能有 < > 符號' };
    if (f.keys != null && (!Array.isArray(f.keys) || f.keys.length > 60)) return { error: '家庭對應格式不對' };
    const fam = meta.baseOf(cards.clean(f?.name, 12));
    if (!fam || [...fam].length > 8) return { error: `「${cards.clean(f?.name, 12)}」這個名稱不行` };
    if (rows.some(r => r.fam === fam)) return { error: `「${fam}家」重複了` };
    rows.push({ fam, ids: whoFromKeys(chatId, f.keys).map(x => x.slice(1)) });
  }
  const before = meta.families(chatId).map(f => `${f.family}家`).join('、');
  const snap = snapFam(chatId);
  db.run('DELETE FROM cal_families WHERE chat_id = ?', chatId);
  for (const r of rows) db.run('INSERT INTO cal_families (chat_id, family, user_ids, updated_at) VALUES (?, ?, ?, ?)', chatId, r.fam, JSON.stringify(r.ids), now);
  const name = (u) => meta.members(chatId).find(m => m.user_id === u)?.name || '某人';
  log(chatId, 'fam', by, `家庭對應：${rows.map(r => `${r.fam}家＝${r.ids.map(name).join('、') || '（沒人）'}`).join('；') || '清空'}（原本：${before || '沒有'}）`, now, snap);
  return { ok: true };
}
export const notifyOn = (chatId) => !!db?.get('SELECT notify FROM cal_settings WHERE chat_id = ?', chatId)?.notify;
export function setNotify(chatId, on, by, now = Date.now()) {
  const snap = { notify: notifyOn(chatId) ? 1 : 0 };
  db.run('INSERT INTO cal_settings (chat_id, notify) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET notify = excluded.notify', chatId, on ? 1 : 0);
  log(chatId, 'set', by, `有人改了要不要在群組說一聲：${on ? '要' : '不要'}`, now, snap);
  return { ok: true };
}

// ── 編輯連結（免登入）與防亂改 ─────────────────────────

/** 雜湊用的鹽（每台機器第一次用時產生，存 DB）：IP、裝置指紋只存雜湊 */
function salt() {
  const r = db.get("SELECT v FROM cal_kv WHERE k = 'salt'");
  if (r) return r.v;
  const v = randomBytes(32).toString('hex');
  db.run("INSERT OR IGNORE INTO cal_kv (k, v) VALUES ('salt', ?)", v);
  return db.get("SELECT v FROM cal_kv WHERE k = 'salt'").v;
}
export const hashOf = (s) => (s ? createHash('sha256').update(`${salt()}:${s}`).digest('hex').slice(0, 16) : '');

/** 這個聊天的編輯碼（沒有就產一個；192 bit，base64url） */
export function editKey(chatId) {
  const r = db.get('SELECT edit_key FROM cal_pages WHERE chat_id = ?', chatId);
  if (!r) return null;
  if (r.edit_key) return r.edit_key;
  const k = randomBytes(24).toString('base64url');
  // key_at 只在手動換的時候記（剛產生的碼外流了也要能馬上換）
  db.run('UPDATE cal_pages SET edit_key = ? WHERE chat_id = ? AND edit_key IS NULL', k, chatId);
  return db.get('SELECT edit_key FROM cal_pages WHERE chat_id = ?', chatId).edit_key;
}
/** 編輯碼對不對（固定時間比對）；停用中也算不對 */
export function keyOk(chatId, key, now = Date.now()) {
  const r = db.get('SELECT edit_key, suspended_until FROM cal_pages WHERE chat_id = ?', chatId);
  if (!r?.edit_key || typeof key !== 'string' || key.length !== r.edit_key.length) return false;
  if (!timingSafeEqual(Buffer.from(key), Buffer.from(r.edit_key))) return false;
  return true;
}
export const suspendedUntil = (chatId) => db.get('SELECT suspended_until FROM cal_pages WHERE chat_id = ?', chatId)?.suspended_until || 0;
export const suspend = (chatId, until) => db.run('UPDATE cal_pages SET suspended_until = ? WHERE chat_id = ?', until, chatId);
/** 換編輯碼：舊的立刻失效、解除停用；5 分鐘內只能換一次 */
export function rotateKey(chatId, by, now = Date.now()) {
  const r = db.get('SELECT key_at FROM cal_pages WHERE chat_id = ?', chatId);
  if (!r) return { error: '這個聊天還沒有行事曆網頁' };
  if (now - (r.key_at || 0) < 5 * 60_000) return { error: '剛換過，5 分鐘後再換' };
  const k = randomBytes(24).toString('base64url');
  db.run('UPDATE cal_pages SET edit_key = ?, key_at = ?, suspended_until = 0 WHERE chat_id = ?', k, now, chatId);
  log(chatId, 'sys', by, '換了編輯連結（舊的失效）', now);
  return { ok: true, key: k };
}

/** 記一筆異常（頻率超過、碼不對、大量刪除…）；回這個聊天 10 分鐘內同類的筆數 */
export function anomaly(chatId, kind, detail = '', iph = '', now = Date.now()) {
  db.run('INSERT INTO cal_anomaly (chat_id, at, kind, detail, iph) VALUES (?, ?, ?, ?, ?)', chatId || '', now, kind, cards.clean(detail, 200), iph);
  return db.get('SELECT COUNT(*) n FROM cal_anomaly WHERE chat_id = ? AND kind = ? AND at > ?', chatId || '', kind, now - 10 * 60_000).n;
}
/** 編輯連結（自報身分）10 分鐘內刪了幾筆 */
export const recentDeletes = (chatId, now = Date.now()) => db.get("SELECT COUNT(*) n FROM cal_history WHERE chat_id = ? AND via = 'key' AND what LIKE '刪除了%' AND at > ?", chatId, now - 10 * 60_000).n;
/** 編輯連結 10 分鐘內改了幾次（每次修改的第一行帶 snap，用它算次數） */
export const recentEdits = (chatId, now = Date.now()) => db.get("SELECT COUNT(*) n FROM cal_history WHERE chat_id = ? AND via = 'key' AND snap IS NOT NULL AND at > ?", chatId, now - 10 * 60_000).n;

// ── 還原到某個時間點（TED） ────────────────────────────

/**
 * 把 ts 之後改過的東西改回 ts 那時的樣子：每一筆取 ts 之後第一次修改存的「改之前的樣子」寫回去
 * 還原本身也記紀錄（帶當下的樣子），所以還原錯了可以再還原回來；回 { ok, n }
 */
export function restoreTo(chatId, ts, by, now = Date.now()) {
  const rows = db.all('SELECT ref, snap FROM cal_history WHERE chat_id = ? AND at > ? AND snap IS NOT NULL ORDER BY id', chatId, ts);
  const first = new Map();
  for (const r of rows) if (!first.has(r.ref)) first.set(r.ref, r.snap);
  const when = new Date(ts + 8 * 3600_000).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ');
  let n = 0;
  for (const [ref, s] of first) {
    let snap; try { snap = JSON.parse(s); } catch { continue; }
    const e = /^e(\d+)$/.exec(ref);
    const t = /^t\|([a-z0-9-]{1,60})\|(\d{4}-\d{2}-\d{2})$/.exec(ref);
    if (e) {
      const cur = db.get('SELECT * FROM cal_events WHERE id = ? AND chat_id = ?', Number(e[1]), chatId);
      if (!cur) continue;
      log(chatId, ref, by, `還原到 ${when} 的樣子`, now, snapEvent(cur));
      if (snap._new) { if (!cur.deleted_at) db.run('UPDATE cal_events SET deleted_at = ?, version = version + 1 WHERE id = ?', now, cur.id); }
      else db.run(`UPDATE cal_events SET ${SNAP_COLS.map(c => `${c} = ?`).join(', ')}, version = version + 1 WHERE id = ?`, ...SNAP_COLS.map(c => snap[c] ?? null), cur.id);
    } else if (t) {
      log(chatId, ref, by, `還原到 ${when} 的樣子`, now, snapTrip(chatId, t[1], t[2]));
      if (snap._none) db.run('DELETE FROM cal_trip_edits WHERE chat_id = ? AND name = ? AND day = ?', chatId, t[1], t[2]);
      else db.run(`INSERT INTO cal_trip_edits (chat_id, name, day, short, who, manual, version) VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(chat_id, name, day) DO UPDATE SET short = excluded.short, who = excluded.who, manual = excluded.manual, version = cal_trip_edits.version + 1`,
      chatId, t[1], t[2], snap.short ?? null, snap.who ?? null, snap.manual || '{}');
    } else if (ref === 'fam' && Array.isArray(snap)) {
      log(chatId, ref, by, `家庭對應還原到 ${when} 的樣子`, now, snapFam(chatId));
      db.run('DELETE FROM cal_families WHERE chat_id = ?', chatId);
      for (const f of snap) db.run('INSERT INTO cal_families (chat_id, family, user_ids, updated_at) VALUES (?, ?, ?, ?)', chatId, f.family, f.user_ids, now);
    } else if (ref === 'set') {
      log(chatId, ref, by, `設定還原到 ${when} 的樣子`, now, { notify: notifyOn(chatId) ? 1 : 0 });
      db.run('INSERT INTO cal_settings (chat_id, notify) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET notify = excluded.notify', chatId, snap.notify ? 1 : 0);
    } else continue;
    n++;
  }
  log(chatId, 'sys', by, `還原到 ${when}（${n} 筆）`, now);
  return { ok: true, n };
}

// ── LIFF（LINE 網頁登入）設定與驗身分 ─────────────────

const LIFF_ID_RE = /^\d{10}-[A-Za-z0-9]{8}$/;
/** 環境變數 XIAOSHUAI_LIFF_ID／XIAOSHUAI_LIFF_CHANNEL_ID，沒有就讀 data/xiaoshuai-liff.json（{ liffId, channelId }，都不是密碼）；沒設定回 null */
export function liffConfig(file = process.env.XIAOSHUAI_LIFF_FILE) {
  let liffId = process.env.XIAOSHUAI_LIFF_ID || '';
  let channelId = process.env.XIAOSHUAI_LIFF_CHANNEL_ID || '';
  if ((!liffId || !channelId) && file && existsSync(file)) {
    try {
      // 檔案很小，每次都讀（改了馬上生效；用修改時間快取會漏掉同一毫秒內的兩次寫入）
      const v = JSON.parse(readFileSync(file, 'utf8'));
      liffId ||= String(v?.liffId || '');
      channelId ||= String(v?.channelId || '');
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
