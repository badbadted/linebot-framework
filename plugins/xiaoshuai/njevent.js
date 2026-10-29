/**
 * 小帥幫忙在妞揪開團（2026-10-27 使用者決定：開了小帥的群都能用；資訊不夠就一直問到齊才開）
 *
 * 流程：有人叫小帥開團 → AI 把對話整理成欄位（只填有人講的）→ 程式驗證、合併到「這個人」的草稿
 *      → 缺什麼由程式列出來問 → 齊了列出完整內容 → 只有發起人本人回「好」才寫進妞揪 Firestore
 *
 * 認人：妞揪 App 的 LINE 登入跟 bot 在不同 provider，同一人兩邊 userId 不同（實測 0/26 相同）
 *      → 第一次用 LINE 名稱對到妞揪帳號（只能剛好一個），之後記住配對（nj_bindings），
 *        改名也冒用不了；同一個妞揪帳號已被別人配走就不給開。
 * 主揪＝發起人本人；帳號要已核准（或管理員）。
 */

import { initFirestore } from '../niujiu/firestore.js';

const DRAFT_TTL_MS = 30 * 60_000;
const APP_URL = (process.env.NIUJIU_URL || 'https://niujiu.vercel.app').replace(/\/$/, '');

export const CATEGORIES = [
  ['outdoor', '戶外活動'], ['picnic', '野餐'], ['camping', '露營'], ['reading', '繪本共讀'],
  ['craft', '手作 DIY'], ['sports', '運動競技'], ['party', '派對聚會'], ['other', '其他'],
];
const CAT_LABEL = Object.fromEntries(CATEGORIES);

let db = null;
let getFs = initFirestore;
const drafts = new Map(); // `${chatId}:${userId}` → { d, at }

export function initNjEvent(database, { firestore } = {}) {
  db = database;
  if (firestore) getFs = firestore;
  db.exec(`
    CREATE TABLE IF NOT EXISTS nj_bindings (
      line_id TEXT PRIMARY KEY,
      nj_uid TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
  `);
}

// 2026-10-29：「小帥幫我牛揪發活動」沒命中 → 沒帶開團說明，AI 自己編「私訊不能開」；補常見錯字與說法
const EVENT_RE = /開團|揪團|開一團|揪一團|開個團|開活動|辦活動|揪活動|發活動|發個活動|發起活動|開個活動|辦個活動|揪人|妞揪|牛揪|紐揪|扭揪|妞糾/;
export const aboutEvent = (text) => EVENT_RE.test(String(text || ''));

const key = (chatId, userId) => `${chatId}:${userId}`;
export function draftOf(chatId, userId) {
  const k = key(chatId, userId);
  const p = drafts.get(k);
  if (p && Date.now() - p.at > DRAFT_TTL_MS) { drafts.delete(k); return null; }
  return p?.d || null;
}
export const clearDraft = (chatId, userId) => drafts.delete(key(chatId, userId));

// ── 驗證 ───────────────────────────────────────────

/** 台北今天 YYYY-MM-DD */
export const todayTaipei = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

const txt = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function validDate(s, today) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== s) return false; // 擋 11/31 這種
  const max = new Date(`${today}T00:00:00Z`); max.setUTCFullYear(max.getUTCFullYear() + 1);
  return s >= today && t <= max;
}
const validTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const money = (v) => (Number.isFinite(+v) && +v >= 0 && +v <= 100000 ? Math.round(+v) : null);
const count = (v) => (Number.isInteger(+v) && +v >= 0 && +v <= 500 ? +v : null);

export function fmtDate(s) {
  const t = new Date(`${s}T00:00:00Z`);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEK[t.getUTCDay()]}）`;
}

/**
 * 把 AI 給的欄位合併進草稿；不合格的欄位不收、記進 problems
 * @returns {{ d: object, problems: string[] }}
 */
export function mergeDraft(prev, patch, now = Date.now()) {
  const d = { ...(prev || {}) };
  const problems = [];
  if (!patch || typeof patch !== 'object') return { d, problems };
  const today = todayTaipei(now);
  const has = (k) => patch[k] !== undefined && patch[k] !== null && patch[k] !== '';

  if (has('title')) d.title = txt(patch.title, 40);
  if (has('description')) d.description = txt(patch.description, 500);
  if (has('location')) d.location = txt(patch.location, 100);
  if (has('location_note')) d.locationNote = txt(patch.location_note, 100);
  if (has('category')) { if (CAT_LABEL[patch.category]) d.category = patch.category; }
  if (has('participants') && ['all', 'adultsOnly', 'kidsOnly'].includes(patch.participants)) d.participantMode = patch.participants;

  if (has('date_mode') && ['fixed', 'voting'].includes(patch.date_mode)) {
    if (d.dateMode && d.dateMode !== patch.date_mode) { delete d.startDate; delete d.endDate; delete d.candidateDates; delete d.votingDeadline; }
    d.dateMode = patch.date_mode;
  }
  if (has('start_date')) {
    if (validDate(patch.start_date, today)) { d.startDate = patch.start_date; d.dateMode = 'fixed'; }
    else problems.push(`日期「${txt(patch.start_date, 12)}」不對（要今天以後、一年內）`);
  }
  if (has('end_date')) {
    if (validDate(patch.end_date, today) && (!d.startDate || patch.end_date >= d.startDate)) d.endDate = patch.end_date;
    else problems.push(`結束日期「${txt(patch.end_date, 12)}」不對`);
  }
  if (has('start_time')) { if (validTime(patch.start_time)) d.startTime = patch.start_time; else problems.push(`時間「${txt(patch.start_time, 8)}」看不懂`); }
  if (has('end_time')) { if (validTime(patch.end_time)) d.endTime = patch.end_time; else problems.push(`結束時間「${txt(patch.end_time, 8)}」看不懂`); }
  if (Array.isArray(patch.candidate_dates) && patch.candidate_dates.length) {
    const ok = [...new Set(patch.candidate_dates.filter(s => validDate(s, today)))].sort().slice(0, 10);
    if (ok.length < patch.candidate_dates.length) problems.push('有幾個候選日期不對，已略過');
    if (ok.length) { d.candidateDates = ok; d.dateMode = 'voting'; }
  }
  if (has('voting_deadline')) {
    if (validDate(patch.voting_deadline, today)) d.votingDeadline = patch.voting_deadline;
    else problems.push(`投票截止日「${txt(patch.voting_deadline, 12)}」不對`);
  }

  const fee = patch.fee;
  if (fee && typeof fee === 'object' && ['free', 'perPerson', 'family', 'custom'].includes(fee.mode)) {
    d.feeMode = fee.mode;
    delete d.adultFee; delete d.kidFee; delete d.familyFee; delete d.feeNote;
    if (fee.mode === 'perPerson') {
      if (money(fee.adult) !== null) d.adultFee = money(fee.adult);
      if (money(fee.kid) !== null) d.kidFee = money(fee.kid);
    }
    if (fee.mode === 'family' && money(fee.family) !== null) d.familyFee = money(fee.family);
    if (fee.mode === 'custom' && fee.note) d.feeNote = txt(fee.note, 100);
  }

  const lim = patch.limit;
  if (lim && typeof lim === 'object') {
    if (lim.none === true) { d.limitSet = true; d.maxAdults = 0; d.maxKids = 0; }
    else {
      const a = count(lim.adults ?? 0), k = count(lim.kids ?? 0);
      if (a !== null && k !== null && a + k > 0) { d.limitSet = true; d.maxAdults = a; d.maxKids = k; }
      else problems.push('人數上限看不懂');
    }
  }
  return { d, problems };
}

/** 還缺什麼（程式判斷，不靠 AI） */
export function missingOf(d) {
  const m = [];
  if (!d.title) m.push('活動名稱');
  if (d.dateMode === 'voting') {
    if ((d.candidateDates || []).length < 2) m.push('候選日期（至少兩天，大家投票）');
  } else {
    if (!d.startDate) m.push('日期（還沒定的話也可以給幾個候選日讓大家投票）');
    if (!d.startTime) m.push('幾點開始');
  }
  if (!d.location) m.push('地點');
  if (!d.feeMode) m.push('費用（免費，或大人／小孩各多少、一家多少）');
  else if (d.feeMode === 'perPerson' && !d.adultFee && !d.kidFee) m.push('每人收多少');
  else if (d.feeMode === 'family' && !d.familyFee) m.push('一家收多少');
  else if (d.feeMode === 'custom' && !d.feeNote) m.push('費用怎麼算');
  if (!d.limitSet) m.push('人數上限（不限也可以）');
  return m;
}

function feeText(d) {
  if (d.feeMode === 'free') return '免費';
  if (d.feeMode === 'perPerson') return [d.adultFee ? `大人 ${d.adultFee} 元` : '', d.kidFee ? `小孩 ${d.kidFee} 元` : ''].filter(Boolean).join('、') || '每人計費';
  if (d.feeMode === 'family') return `一家 ${d.familyFee} 元`;
  if (d.feeMode === 'custom') return d.feeNote;
  return '';
}

/** 給人看的草稿內容（程式產生：看到什麼就開什麼） */
export function describeDraft(d) {
  const lines = [];
  if (d.title) lines.push(`・名稱：${d.title}`);
  if (d.dateMode === 'voting' && d.candidateDates?.length) {
    lines.push(`・日期：投票（${d.candidateDates.map(fmtDate).join('、')}）${d.votingDeadline ? `，${fmtDate(d.votingDeadline)} 截止` : ''}`);
  } else if (d.startDate) {
    const end = d.endDate && d.endDate !== d.startDate ? ` ～ ${fmtDate(d.endDate)}` : '';
    lines.push(`・日期：${fmtDate(d.startDate)}${end}${d.startTime ? ` ${d.startTime}${d.endTime ? `～${d.endTime}` : ''}` : ''}`);
  }
  if (d.location) lines.push(`・地點：${d.location}${d.locationNote ? `（${d.locationNote}）` : ''}`);
  if (d.feeMode) lines.push(`・費用：${feeText(d)}`);
  if (d.limitSet) {
    const lim = !d.maxAdults && !d.maxKids ? '不限' : [d.maxAdults ? `大人 ${d.maxAdults}` : '', d.maxKids ? `小孩 ${d.maxKids}` : ''].filter(Boolean).join('、');
    lines.push(`・人數：${lim}`);
  }
  if (d.participantMode === 'adultsOnly') lines.push('・限大人');
  if (d.participantMode === 'kidsOnly') lines.push('・只收小孩');
  lines.push(`・分類：${CAT_LABEL[d.category || 'other']}`);
  if (d.description) lines.push(`・說明：${d.description}`);
  return lines;
}

// ── 認人 ───────────────────────────────────────────

const approved = (u) => u.role === 'admin' || (u.status ?? 'approved') === 'approved';

/**
 * LINE 使用者 → 妞揪帳號（主揪）
 * @returns {Promise<{ok:true, user:{uid, displayName, avatarUrl}} | {ok:false, error:string}>}
 */
export async function resolveHost(lineId, displayName) {
  if (!lineId) return { ok: false, error: '認不出你是誰' };
  const fs = await getFs();
  const bound = db.get('SELECT nj_uid FROM nj_bindings WHERE line_id = ?', lineId);
  let uid = bound?.nj_uid;
  if (!uid) {
    if (!displayName) return { ok: false, error: '認不出你是誰' };
    const snap = await fs.collection('users').where('displayName', '==', displayName).limit(2).get();
    if (snap.empty) return { ok: false, error: `妞揪找不到「${displayName}」，請先用 LINE 登入妞揪 App（${APP_URL}）` };
    if (snap.size > 1) return { ok: false, error: '妞揪有同名的人，小帥分不出是哪一位，請到 App 開團' };
    uid = snap.docs[0].id;
    const taken = db.get('SELECT line_id FROM nj_bindings WHERE nj_uid = ?', uid);
    if (taken && taken.line_id !== lineId) return { ok: false, error: '這個妞揪帳號已經配對給別人了，請到 App 開團' };
    db.run('INSERT OR IGNORE INTO nj_bindings (line_id, nj_uid) VALUES (?, ?)', lineId, uid);
    console.log(`[xiaoshuai-nj] 配對妞揪帳號 ${lineId.slice(0, 6)}… → ${uid.slice(0, 6)}…`);
  }
  const doc = await fs.collection('users').doc(uid).get();
  if (!doc.exists) return { ok: false, error: '妞揪帳號不見了，請到 App 重新登入' };
  const u = doc.data();
  if (!approved(u)) return { ok: false, error: '你的妞揪帳號還在等管理員核准，核准後才能開團' };
  return { ok: true, user: { uid, displayName: u.displayName || displayName || '', avatarUrl: u.avatarUrl || '' } };
}

// ── 建立 ───────────────────────────────────────────

export function eventDoc(d, host, now = Date.now()) {
  const maxAdults = d.maxAdults || 0, maxKids = d.maxKids || 0;
  const doc = {
    title: d.title,
    description: d.description || '',
    hostId: host.uid, hostName: host.displayName, hostAvatar: host.avatarUrl,
    visibility: 'public',
    dateMode: d.dateMode === 'voting' ? 'voting' : 'fixed',
    location: d.location,
    locationNote: d.locationNote || '',
    maxParticipants: maxAdults + maxKids, maxAdults, maxKids,
    currentParticipants: 0, currentAdults: 0, currentKids: 0,
    status: d.dateMode === 'voting' ? 'voting' : 'upcoming',
    tags: [],
    category: d.category || 'other',
    participantMode: d.participantMode || 'all',
    feeMode: d.feeMode,
    createdVia: 'linebot',
    createdAt: now, updatedAt: now,
  };
  if (d.feeMode === 'perPerson') { doc.adultFee = d.adultFee || 0; doc.kidFee = d.kidFee || 0; }
  if (d.feeMode === 'family') doc.familyFee = d.familyFee;
  if (d.feeMode === 'custom') doc.feeNote = d.feeNote;
  if (doc.dateMode === 'fixed') {
    doc.startDate = d.startDate;
    doc.endDate = d.endDate || d.startDate;
    doc.startTime = d.startTime;
    if (d.endTime) doc.endTime = d.endTime;
  } else {
    doc.candidateDates = d.candidateDates;
    if (d.votingDeadline) doc.votingDeadline = d.votingDeadline;
  }
  return doc;
}

export async function createEvent(d, host) {
  const fs = await getFs();
  const ref = await fs.collection('events').add(eventDoc(d, host));
  return { id: ref.id, url: `${APP_URL}/event/${ref.id}` };
}

/** 存草稿（只有發起人自己的） */
export function saveDraft(chatId, userId, d) { drafts.set(key(chatId, userId), { d, at: Date.now() }); }

// ── 給 AI 的說明 ───────────────────────────────────

export function promptSection(draft, now = Date.now()) {
  const today = todayTaipei(now);
  const lines = [
    '',
    '',
    `【妞揪開團】（今天是 ${today}，星期${WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()]}）`,
    '有人要你幫他在妞揪開團（揪活動）時，JSON 加 "nj_event"，只填【叫你的那句】跟前面對話裡他真的講過的欄位，沒講的不要填、不要自己編：',
    '{"title":"活動名稱（他沒講但內容很清楚可以幫取，例如「大安森林公園野餐」）","date_mode":"fixed 或 voting（日期還沒定、要大家投票）","start_date":"YYYY-MM-DD","end_date":"多天才填","start_time":"HH:mm","end_time":"HH:mm","candidate_dates":["YYYY-MM-DD"],"voting_deadline":"YYYY-MM-DD","location":"地點","location_note":"集合點等補充","category":"' + CATEGORIES.map(c => `${c[0]}=${c[1]}`).join('、') + '","participants":"all／adultsOnly／kidsOnly","fee":{"mode":"free／perPerson／family／custom","adult":0,"kid":0,"family":0,"note":"custom 才填"},"limit":{"none":true} 或 {"adults":0,"kids":0},"description":"活動說明"}',
    '「週六」「下週日」這種要換成日期；講「免費」fee.mode 填 free；講「不限人數」limit 填 {"none":true}。開團時不要上網查資料。',
    'reply 只要一句短話（例如「好，我幫你整理」），缺什麼、草稿內容系統會另外附上，你不用列、不用問。',
  ];
  if (draft) {
    lines.push('', '〔這個人正在開的團（草稿）〕', ...describeDraft(draft));
    const m = missingOf(draft);
    lines.push(m.length ? `還缺：${m.join('、')}` : '資料已經齊了，在等他回「好」。');
    lines.push('他這句如果是在補資料或改內容，照上面格式只放有變的欄位；如果是同意開團（好、OK、可以、開吧），JSON 加 "nj_confirm": true；如果是不開了、取消，加 "nj_confirm": false。');
  }
  return lines.join('\n');
}
