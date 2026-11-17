/**
 * 小帥主動提議（2026-11-17，版面照 共用/AI產出/mockup/小帥主動提議與倒數預覽.html 一句話版）
 *
 * 沒人叫小帥時，他看到「可以幫忙」的時候只用一句短話問大家，不出卡片、不放按鈕，大家打字回：
 *   calendar — 有人講到某天某時的事 →「要幫大家記到行事曆嗎？11/21（六）09:00 練球」
 *              有人回好就記；30 分鐘沒人說不要也記（安靜記好，不另外講話，問到才說）
 *   vote     — 大家在選（吃什麼、去哪）→「要不要開個投票？燒肉、拉麵」；有人回好才開，沒人回就算了
 *   food     — 有人貼 Google 地圖連結 → 只問貼的人「要把這家收進我們的美食嗎？」；他本人回好才收
 *
 * 不吵（使用者 2026-11-17 定：不要讓大家厭煩、重複的少）：
 *   - 每群每天最多主動問 low 2 次／on 4 次；off 不問（/小帥 主動 開｜少｜關，預設少）
 *   - 同一件事只問一次（asked_keys 留 60 天）；被說不要，這一類今天不再問；連續 2 次沒人理，今天停
 *   - 一個群同時只掛一個提議；熱聊（1 分鐘內 5 則以上）不插嘴
 * 不推播：問、做、回都用當下那則訊息的免費回覆；calendar 到期安靜記好，不發訊息。
 *
 * 這裡放純邏輯與資料（時間可注入，方便測試）；偵測用的 AI、真的去記／開／收在 index.js。
 */

export const ASK_TTL_MS = 30 * 60_000;     // 提議等回答多久
export const DAILY_CAP = { low: 2, on: 4, off: 0 };
export const IGNORE_STOP = 2;              // 連續幾次沒人理，今天停
export const BUSY_WINDOW_MS = 60_000;
export const BUSY_MSGS = 5;
export const KEY_KEEP_MS = 60 * 86400_000;
export const RECENT_MS = 10 * 60_000;      // 看最近多久的對話判斷

const TZ = 8 * 3600_000;
export const dayKey = (now = Date.now()) => new Date(now + TZ).toISOString().slice(0, 10);

let db = null;

export function initNudge(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudge_state (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'low',
      day TEXT NOT NULL DEFAULT '',
      asked INTEGER NOT NULL DEFAULT 0,
      ignored INTEGER NOT NULL DEFAULT 0,
      declined TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS nudge_keys (
      chat_id TEXT NOT NULL,
      key TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, key)
    );
    CREATE TABLE IF NOT EXISTS nudge_pending (
      chat_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      only_user TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '',
      asked_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nudge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      outcome TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
}

// ── 回答 ───────────────────────────────────────────

const YES_RE = /^(?:小帥\s*[,，、]?\s*)?(?:好+|好啊|好呀|好喔|好哦|好的|好耶|可以|可|ok|okay|\+1|＋1|讚|要|要啊|麻煩了?|麻煩你|拜託|記|記一下|開|開吧|收|收吧|贊成|同意|沒問題|對)(?:\s*(?:啊|呀|喔|哦|吧|唷|囉|啦|耶|欸|謝謝|感謝|你))*[!！。.~～\s]*$/i;
const NO_RE = /^(?:小帥\s*[,，、]?\s*)?(?:不要|不用|不需要|不必|算了|免了?|先不要|先不用|不了|no|nope|別|不行|不好)(?:\s*(?:啦|了|喔|哦|吧|謝謝|感謝))*[!！。.~～\s]*$/i;

/** 這句是在回提議嗎：'yes'｜'no'｜null（只認短句，避免把聊天當成回答） */
export function parseAnswer(text) {
  const t = String(text || '').normalize('NFKC').trim();
  if (!t || Array.from(t).length > 12) return null;
  if (NO_RE.test(t)) return 'no';
  if (YES_RE.test(t)) return 'yes';
  return null;
}

// ── 狀態與節制 ──────────────────────────────────────

/** 讀這群今天的狀態（換日自動歸零） */
export function stateOf(chatId, now = Date.now()) {
  const today = dayKey(now);
  let s = db.get('SELECT * FROM nudge_state WHERE chat_id = ?', chatId);
  if (!s) {
    db.run('INSERT INTO nudge_state (chat_id, day) VALUES (?, ?)', chatId, today);
    s = { chat_id: chatId, mode: 'low', day: today, asked: 0, ignored: 0, declined: '[]' };
  } else if (s.day !== today) {
    db.run("UPDATE nudge_state SET day = ?, asked = 0, ignored = 0, declined = '[]' WHERE chat_id = ?", today, chatId);
    s = { ...s, day: today, asked: 0, ignored: 0, declined: '[]' };
  }
  let declined = [];
  try { declined = JSON.parse(s.declined || '[]'); } catch { /* 壞了就當沒有 */ }
  return { mode: s.mode || 'low', asked: s.asked, ignored: s.ignored, declined };
}

export function setMode(chatId, mode, now = Date.now()) {
  if (!['low', 'on', 'off'].includes(mode)) return false;
  stateOf(chatId, now);
  db.run('UPDATE nudge_state SET mode = ? WHERE chat_id = ?', mode, chatId);
  if (mode === 'off') db.run('DELETE FROM nudge_pending WHERE chat_id = ?', chatId);
  return true;
}

/** 有沒有人在熱聊：最近 1 分鐘別人講了 5 則以上 */
export function busy(buf = [], now = Date.now()) {
  return buf.filter(x => !x.self && now - (x.ts || 0) <= BUSY_WINDOW_MS).length >= BUSY_MSGS;
}

export const asked = (chatId, key) => !!db.get('SELECT 1 FROM nudge_keys WHERE chat_id = ? AND key = ?', chatId, key);

/**
 * 現在可以問這一類嗎。回 { ok:true } 或 { ok:false, why }
 * key 給了就順便檢查同一件事問過沒
 */
export function canAsk(chatId, kind, { key = '', buf = [], now = Date.now() } = {}) {
  const s = stateOf(chatId, now);
  if (s.mode === 'off') return { ok: false, why: 'off' };
  if (s.asked >= (DAILY_CAP[s.mode] ?? DAILY_CAP.low)) return { ok: false, why: 'cap' };
  if (s.ignored >= IGNORE_STOP) return { ok: false, why: 'ignored' };
  if (s.declined.includes(kind)) return { ok: false, why: 'declined' };
  if (pendingOf(chatId, now)) return { ok: false, why: 'pending' };
  if (busy(buf, now)) return { ok: false, why: 'busy' };
  if (key && asked(chatId, key)) return { ok: false, why: 'asked' };
  return { ok: true };
}

// ── 提議 ───────────────────────────────────────────

/** 掛上一個提議（呼叫端已經把問句送出去了才記） */
export function open(chatId, { kind, key, payload = {}, onlyUser = '', question = '' }, now = Date.now()) {
  stateOf(chatId, now);
  db.run('UPDATE nudge_state SET asked = asked + 1 WHERE chat_id = ?', chatId);
  db.run('INSERT OR REPLACE INTO nudge_keys (chat_id, key, at) VALUES (?, ?, ?)', chatId, key, now);
  db.run('INSERT OR REPLACE INTO nudge_pending (chat_id, kind, key, payload, only_user, question, asked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    chatId, kind, key, JSON.stringify(payload), onlyUser, question, now, now + ASK_TTL_MS);
  log(chatId, kind, key, 'asked', now);
}

const rowToPending = (r) => {
  if (!r) return null;
  let payload = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch { /* 空的 */ }
  return { chatId: r.chat_id, kind: r.kind, key: r.key, payload, onlyUser: r.only_user, question: r.question, askedAt: r.asked_at, expiresAt: r.expires_at };
};

/** 這群還在等回答的提議（過期的不算；過期的由 sweep 收） */
export function pendingOf(chatId, now = Date.now()) {
  const p = rowToPending(db.get('SELECT * FROM nudge_pending WHERE chat_id = ?', chatId));
  return p && p.expiresAt > now ? p : null;
}

/**
 * 有人講了一句，看是不是在回提議。
 * 回 null（不是）｜{ answer:'yes'|'no', pending }；回答後提議就收掉（yes 的動作由呼叫端做）
 */
export function answer(chatId, userId, text, now = Date.now()) {
  const p = pendingOf(chatId, now);
  if (!p) return null;
  if (p.onlyUser && p.onlyUser !== userId) return null; // food：只有貼的人回才算
  const a = parseAnswer(text);
  if (!a) return null;
  db.run('DELETE FROM nudge_pending WHERE chat_id = ?', chatId);
  stateOf(chatId, now);
  db.run('UPDATE nudge_state SET ignored = 0 WHERE chat_id = ?', chatId);
  if (a === 'no') declineToday(chatId, p.kind, now);
  log(chatId, p.kind, p.key, a === 'yes' ? 'yes' : 'no', now);
  return { answer: a, pending: p };
}

function declineToday(chatId, kind, now) {
  const s = stateOf(chatId, now);
  if (!s.declined.includes(kind)) db.run('UPDATE nudge_state SET declined = ? WHERE chat_id = ?', JSON.stringify([...s.declined, kind]), chatId);
}

/**
 * 收過期的提議。calendar 沒人反對＝要記（回傳給呼叫端去記）；其他算沒人理（ignored +1）。
 * 回 [{ ...pending, silent:true }]（要安靜記的 calendar）
 */
export function sweep(now = Date.now()) {
  if (!db) return [];
  const rows = db.all('SELECT * FROM nudge_pending WHERE expires_at <= ?', now).map(rowToPending);
  const toDo = [];
  for (const p of rows) {
    db.run('DELETE FROM nudge_pending WHERE chat_id = ? AND key = ?', p.chatId, p.key);
    if (p.kind === 'calendar') { toDo.push({ ...p, silent: true }); log(p.chatId, p.kind, p.key, 'silent', now); continue; }
    stateOf(p.chatId, now);
    db.run('UPDATE nudge_state SET ignored = ignored + 1 WHERE chat_id = ?', p.chatId);
    log(p.chatId, p.kind, p.key, 'ignored', now);
  }
  db.run('DELETE FROM nudge_keys WHERE at < ?', now - KEY_KEEP_MS);
  db.run('DELETE FROM nudge_log WHERE at < ?', now - KEY_KEEP_MS);
  return toDo;
}

export function log(chatId, kind, key, outcome, now = Date.now()) {
  try { db.run('INSERT INTO nudge_log (chat_id, kind, key, outcome, at) VALUES (?, ?, ?, ?, ?)', chatId, kind, key, outcome, now); } catch { /* 記錄失敗不影響主流程 */ }
}

/** 統計（/小帥 主動 用）：最近 14 天各結果的次數 */
export function stats(chatId, now = Date.now()) {
  const rows = db.all('SELECT outcome, COUNT(*) AS n FROM nudge_log WHERE chat_id = ? AND at >= ? GROUP BY outcome', chatId, now - 14 * 86400_000);
  return Object.fromEntries(rows.map(r => [r.outcome, r.n]));
}

// ── 偵測（規則粗篩；命中才請 AI 判斷，平常聊天不花錢） ──

const MAPS_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\/\S+/i;
export const mapsUrlIn = (text) => (String(text || '').match(MAPS_RE) || [null])[0];

const CHOOSE_RE = /吃什麼|吃啥|吃哪|要吃|去哪|去哪裡|哪家|哪間|哪個好|選哪|還是|要選|決定不了|想不到/;

/**
 * 這一句值得想想要不要問嗎。回一類（'food'｜'calendar'｜'vote'）或 null。
 * looksLikeCalendar 由呼叫端傳入（calendar.js 的），避免這裡依賴整個行事曆模組。
 */
export function prefilter(text, buf = [], { looksLikeCalendar = () => false, now = Date.now() } = {}) {
  const t = String(text || '').normalize('NFKC').trim();
  if (!t || /^\//.test(t)) return null;
  if (mapsUrlIn(t)) return 'food';
  if (looksLikeCalendar(t, now)) return 'calendar';
  if (CHOOSE_RE.test(t)) {
    // 要有兩個以上的人在聊這件事才問投票
    const speakers = new Set(buf.filter(x => !x.self && now - (x.ts || 0) <= RECENT_MS).map(x => x.userId || x.name));
    if (speakers.size >= 2) return 'vote';
  }
  return null;
}

// ── 問句（程式組，不讓 AI 自由發揮，保持一句話） ──

export function calendarQuestion({ label, title, place }) {
  return `要幫大家記到行事曆嗎？${label} ${title}${place ? ` 📍${place}` : ''}`;
}
export function voteQuestion(options) {
  return `要不要開個投票？${options.join('、')}`;
}
export function foodQuestion(name) {
  return `${name ? `${name}，` : ''}要把這家收進我們的美食嗎？`;
}
