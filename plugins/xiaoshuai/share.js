/**
 * 小帥把妞揪活動分享到別的群組（2026-10-29，只有管理員 TED 能用）
 *
 * 「小帥 把這個活動分享到妞揪群組」「把剛剛那團貼到妞揪親子團」：
 *   1. 認活動：這句或最近對話裡的妞揪活動網址 → 這個聊天剛開好的團 → 照名稱在妞揪 Firestore 找；找不到或不只一個就反問
 *   2. 認目標群：bot 所在的群組（/api/groups）比對名稱；對到多個就列出來問
 *   3. 一次問清楚兩種選法（2026-10-29 使用者簡化）：回「好」＝排進那群、等有人講話時免費貼出；
 *      回「推」＝馬上推播（問的時候就寫出會扣幾則＝群組人數、本月剩幾則，都由程式查），回了就直接推，不再二次確認
 *   4. 排的方式：目標群的 held_answers，等那群下一則「沒有人要回」的訊息用它的免費回覆貼出（最多等 3 天）
 * 卡片：活動名稱、日期時間、地點、主揪、費用、人數；「報名」按鈕只連妞揪自己的網域（程式組網址）。
 */

import * as cards from './cards.js';
import { initFirestore } from '../niujiu/firestore.js';

export const APP_URL = (process.env.NIUJIU_URL || 'https://niujiu.vercel.app').replace(/\/$/, '');
const APP_HOST = new URL(APP_URL).hostname;
export const SHARE_KEEP_MS = 3 * 86400_000;
const PENDING_TTL_MS = 15 * 60_000;
const NJ_COLOR = '#d9534f';
const EVENT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

let db = null;
let getFs = initFirestore;
let listGroups = async () => [];
let memberCount = async () => null;
let quotaOf = async () => null;   // { limit, used }：本月推播額度
const pending = new Map(); // chatId → { stage: 'confirm'|'push', event, target, count?, at }

export function initShare(database, { firestore, groups, members, quota } = {}) {
  db = database;
  if (firestore) getFs = firestore;
  if (groups) listGroups = groups;
  if (members) memberCount = members;
  if (quota) quotaOf = quota;
  db.exec(`
    CREATE TABLE IF NOT EXISTS nj_recent (
      chat_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS share_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      target_chat TEXT NOT NULL,
      target_name TEXT NOT NULL DEFAULT '',
      by_user TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'reply',
      held_id INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at INTEGER NOT NULL,
      posted_at INTEGER
    );
  `);
}

// ── 活動 ──────────────────────────────────────────

/** 妞揪活動網址 → 活動 ID（只認妞揪自己的網域、/event/<id>）；不是回 null */
export function eventIdFromUrl(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' || x.hostname !== APP_HOST) return null;
    const m = /^\/event\/([^/]+)\/?$/.exec(x.pathname);
    return m && EVENT_ID_RE.test(m[1]) ? m[1] : null;
  } catch { return null; }
}
export const eventUrl = (id) => (EVENT_ID_RE.test(String(id)) ? `${APP_URL}/event/${id}` : null);
const urlsIn = (t) => [...String(t || '').matchAll(/https?:\/\/[^\s<>"'，。、）)]+/gi)].map(m => m[0]);

/** 小帥開好團時記下來（「剛剛那團」） */
export function rememberCreated(chatId, id, title, now = Date.now()) {
  if (!db || !EVENT_ID_RE.test(String(id))) return;
  db.run(`INSERT INTO nj_recent (chat_id, event_id, title, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET event_id = excluded.event_id, title = excluded.title, at = excluded.at`, chatId, id, cards.clean(title, 60), now);
}

async function loadEvent(id) {
  const fs = await getFs();
  const doc = await fs.collection('events').doc(id).get();
  return doc.exists ? { id, ...doc.data() } : null;
}

const grams = (t) => { const out = new Set(); for (const run of String(t).normalize('NFKC').toLowerCase().match(/[一-鿿぀-ヿa-z0-9]{2,}/g) || []) for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2)); return out; };
const COMMON = new Set(['小帥', '分享', '活動', '這個', '剛剛', '那團', '妞揪', '群組', '親子', '子團', '貼到', '貼去', '幫我', '一下']);

/**
 * 認出要分享的活動
 * @returns {{ event } | { ask: string }}
 */
export async function findEvent(chatId, text, transcript = [], now = Date.now()) {
  // 1. 這句或最近對話裡的妞揪網址
  const fromText = urlsIn(text).map(eventIdFromUrl).find(Boolean)
    || [...transcript].reverse().flatMap(t => urlsIn(t.text)).map(eventIdFromUrl).find(Boolean);
  if (fromText) {
    const ev = await loadEvent(fromText);
    return ev ? { event: ev } : { ask: '這個活動在妞揪找不到（可能被刪了），再給我一次網址？' };
  }
  // 2. 這個聊天剛開好的團（一天內）
  const recent = db.get('SELECT event_id FROM nj_recent WHERE chat_id = ? AND at > ?', chatId, now - 86400_000);
  // 講「剛剛／剛才」才是指剛開的那團（「野餐那團」是在講名稱，交給下面照名稱找）
  if (recent && /剛剛|剛開|剛才/.test(String(text))) {
    const ev = await loadEvent(recent.event_id);
    if (ev) return { event: ev };
  }
  // 3. 照名稱在妞揪找（還沒過的活動）：只取「把 ○○ 分享到…」的 ○○
  const name = String(text).normalize('NFKC').replace(/^.*?小帥\s*[,，、]?\s*/, '').replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:分享|轉貼|轉發|貼|轉|發|丟)\s*(?:到|去|給|進).*$/, '').replace(/^(?:幫我|請)?\s*把/, '')
    .replace(/那團|這團|這個活動|那個活動|這個|那個|活動|行程|幫我|我是要你|我要你|你幫我|請你|有活動|的/g, ' ');
  const want = new Set([...grams(name)].filter(g => !COMMON.has(g)));
  if (want.size) {
    const fs = await getFs();
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const snap = await fs.collection('events').where('startDate', '>=', today).limit(100).get();
    const hits = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .map(e => ({ e, n: [...grams(e.title)].filter(g => want.has(g)).length })).filter(x => x.n >= Math.min(2, want.size))
      .sort((a, b) => b.n - a.n);
    if (hits.length === 1 || (hits.length > 1 && hits[0].n > hits[1].n)) return { event: hits[0].e };
    if (hits.length > 1) return { ask: `是哪一團？${hits.slice(0, 4).map(x => `「${cards.clean(x.e.title, 20)}」`).join('、')}` };
    // 有講名稱卻找不到：問，不要拿別團頂替
    return { ask: `妞揪找不到「${cards.clean(name.trim(), 20)}」這團，貼活動網址給我？` };
  }
  if (recent) {
    const ev = await loadEvent(recent.event_id);
    if (ev) return { event: ev };
  }
  return { ask: '是哪個活動？貼妞揪的活動網址給我，或說活動名稱' };
}

// ── 目標群組 ──────────────────────────────────────

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
/** 「妞揪群組」→ 對到「妞揪親子團」；回 { group } 或 { ask } */
export async function findTarget(phrase, { exclude = null } = {}) {
  // 「妞揪的LINE群組去」「妞揪群」「妞揪那邊」→「妞揪」
  const want = norm(phrase).replace(/line|賴/g, '').replace(/(?:那邊|那裡|裡面|上面|一下|過去|去|吧|喔|啦)+$/, '').replace(/的?(?:群組|群)$/, '').replace(/的$/, '');
  if (!want) return { ask: '要貼到哪個群組？' };
  const groups = (await listGroups()).filter(g => g.id !== exclude);
  const wg = grams(want);
  const hit = groups.filter(g => norm(g.name).includes(want) || norm(want).includes(norm(g.name)) || (wg.size > 0 && [...wg].every(x => grams(g.name).has(x))));
  const exact = groups.filter(g => norm(g.name) === want);
  const list = exact.length ? exact : hit;
  if (list.length === 1) return { group: list[0] };
  if (!list.length) return { ask: `找不到「${cards.clean(phrase, 20)}」這個群組（小帥要先在那個群裡）` };
  return { ask: `你是說哪一個？${list.map(g => `「${g.name}」`).join('、')}` };
}

// ── 卡片 ──────────────────────────────────────────

const WEEK = '日一二三四五六';
function whenText(e) {
  if (e.dateMode === 'voting') return `日期投票中${e.votingDeadline ? `（${e.votingDeadline} 截止）` : ''}`;
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.startDate || '');
  if (!d) return '';
  const w = WEEK[new Date(`${e.startDate}T00:00:00Z`).getUTCDay()];
  return `${+d[2]}/${+d[3]}（${w}）${e.startTime ? ` ${e.startTime}` : ''}${e.endTime ? `～${e.endTime}` : ''}`;
}
function feeText(e) {
  if (e.feeMode === 'free') return '免費';
  if (e.feeMode === 'perPerson') return `大人 ${e.adultFee || 0}・小孩 ${e.kidFee || 0} 元`;
  if (e.feeMode === 'family') return `每家 ${e.familyFee || 0} 元`;
  if (e.feeMode === 'custom') return cards.clean(e.feeNote, 30);
  return '';
}
const peopleText = (e) => (e.maxParticipants ? `${e.currentParticipants || 0}／${e.maxParticipants} 人` : (e.currentParticipants ? `已 ${e.currentParticipants} 人` : '不限人數'));

/** 活動卡＋前面一句短話；報名按鈕只連妞揪網域 */
export function eventMessages(e) {
  const url = cards.safeUri(eventUrl(e.id), (u) => new URL(u).hostname === APP_HOST);
  const rows = [['日期', whenText(e)], ['地點', e.location], ['主揪', e.hostName], ['費用', feeText(e)], ['人數', peopleText(e)]].filter(r => cards.clean(r[1], 40));
  const bubble = cards.bubble({
    color: NJ_COLOR, sub: '📣 妞揪活動', title: e.title,
    rows: rows.slice(0, 4), more: Math.max(0, rows.length - 4),
    buttons: [url && { label: '報名', uri: url, primary: true }],
  });
  const title = cards.clean(e.title, 40);
  const alt = [`📣 妞揪活動：${title}`, ...rows.map(([k, v]) => `${k}：${cards.clean(v, 40)}`), url ? `報名：${url}` : ''].filter(Boolean).join('\n');
  return [{ type: 'text', text: `📣 新活動：${title}，要參加的點報名 👇` }, cards.flex([bubble], alt)];
}

// ── 確認、排、狀態 ────────────────────────────────

export function setPending(chatId, p) { pending.set(chatId, { ...p, at: Date.now() }); }
export function pendingOf(chatId, now = Date.now()) {
  const p = pending.get(chatId);
  if (p && now - p.at > PENDING_TTL_MS) { pending.delete(chatId); return null; }
  return p || null;
}
export const clearPending = (chatId) => pending.delete(chatId);
export const groupMembers = (id) => memberCount(id);
/** 本月推播還剩幾則；查不到或不限量回 null */
export async function quotaLeft() {
  try {
    const q = await quotaOf();
    return q && Number.isFinite(q.limit) ? Math.max(0, q.limit - (q.used || 0)) : null;
  } catch { return null; }
}

/** 問 TED 的那句：兩種選法一次講清楚（人數、剩餘額度由程式查） */
export function askText(event, target, count, left) {
  const cost = count == null ? '會依群組人數扣額度' : `會扣 ${count} 則`;
  const rest = left == null ? '' : `，本月剩 ${left} 則`;
  return `要把「${cards.clean(event.title, 30)}」貼到「${target.name}」嗎？\n回「好」＝等那群有人講話時免費貼出（最多等 3 天）\n回「推」＝馬上推播（${cost}${rest}）`;
}

export function recordJob({ event, target, by, mode, heldId = null }, now = Date.now()) {
  const r = db.run(`INSERT INTO share_jobs (event_id, title, target_chat, target_name, by_user, mode, held_id, status, created_at, posted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, event.id, cards.clean(event.title, 60), target.id, cards.clean(target.name, 40), by || '', mode, heldId,
  mode === 'push' ? 'posted' : 'queued', now, mode === 'push' ? now : null);
  return r.lastInsertRowid;
}
/** held_answers 貼出去了 → 對應的分享標成已貼出 */
export function markPosted(heldIds, now = Date.now()) {
  for (const id of heldIds || []) db?.run("UPDATE share_jobs SET status = 'posted', posted_at = ? WHERE held_id = ? AND status = 'queued'", now, id);
}

const fmt = (ts) => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** 「剛剛那團貼出去了沒」 */
export function statusText(byUser, now = Date.now()) {
  const j = db?.get('SELECT * FROM share_jobs WHERE by_user = ? ORDER BY id DESC LIMIT 1', byUser);
  if (!j) return '最近沒有分享過活動喔';
  const head = `「${j.title}」→「${j.target_name}」`;
  if (j.status === 'posted') return `${head}：已貼出（${fmt(j.posted_at)}${j.mode === 'push' ? '，推播' : ''}）`;
  if (now - j.created_at > SHARE_KEEP_MS) return `${head}：排了 3 天那群都沒人講話，沒貼出去`;
  return `${head}：排著，等那群有人講話就會貼出（${fmt(j.created_at)} 排的，最多等 3 天）`;
}
