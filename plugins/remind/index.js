/**
 * Remind Plugin — 獨立的定時提醒
 *
 * /提醒 18:00 開會              → 今天 18:00 提醒（過了排明天）
 * /提醒 明天 09:00 交報告
 * /提醒 12/25 10:00 聖誕
 * /提醒 30分鐘後 倒垃圾          → 相對時間
 * /提醒 2小時後 回電
 * /提醒                         → 看我的待提醒
 * /提醒取消 1                   → 取消第 1 筆
 *
 * 範圍：在哪設就在哪提醒（群組→群組、私訊→你）。
 *
 * 送法（2026-11-19 改）：一律用「回覆」，不推播（推播依群組人數扣 LINE 額度）。
 *   時間到只把提醒標成「已到期、待送」（due=1）；之後那個群組／私訊有人說話、bot 要回覆時，
 *   由 core/reply-extras.js 把到期的提醒併進那次回覆（同一個 replyToken）；沒人要回的訊息
 *   （貼圖、照片、沒命中指令的話）也會用 onIdleReply 拿那則的回覆送出。
 *   送出後標 fired=1、記 delivered_at；狀態都在 remind.db，重啟照樣接得上。
 *   到期超過 10 分鐘才送出的，會標「原定 MM/DD HH:mm」。
 *
 * 匯出 parseReminder / createReminderFromText 給小帥用（口語設提醒，共用同一套時間解析）。
 * 需求 Provider：db（SQLite）+ scheduler
 */

import { flex } from '../../src/utils/flex.js';

let db, scheduler, lineApi;
const COLOR = '#f59e0b'; // 琥珀
const LATE_MS = 10 * 60_000;      // 到期超過這麼久才送 → 標「原定」
const DEFAULT_TIME = { h: 9, m: 0 }; // 只給日期沒給時間 → 早上 9:00
export const WAIT_NOTE = '時間到之後，有人在這裡說話時小帥會提醒';
const inflight = new Set();       // 正在送的提醒 id（同一聊天兩個回覆同時送時不重複帶）

// 「現在」這個瞬間與時區無關，直接用 new Date()——原本的 toLocaleString round-trip 在非台北主機會
// 把牆鐘字串用伺服器本地時區誤判，導致所有提醒偏移數小時。
// 注意：下方絕對時間分支（setHours / new Date(y,mo,d,...)）以伺服器本地時區建構牆鐘時間，
// 假設部署主機時區為 Asia/Taipei（台灣固定 UTC+8、無日光節約）；若改部署到非台北主機需改用具時區能力的方式建構。
function nowTW() {
  return new Date();
}
/** 台北時間 MM/DD HH:mm（自己組，不靠 toLocaleString 的分隔字元） */
function fmt(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}
function normalize(s) {
  return String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ').replace(/[／]/g, '/').replace(/[：]/g, ':');
}

// 時段詞 → am / pm / noon；沒給幾點時各時段的預設
const PART = { 凌晨: 'am', 早上: 'am', 上午: 'am', 中午: 'noon', 下午: 'pm', 晚上: 'pm', 傍晚: 'pm', 夜晚: 'pm' };
const PART_DEFAULT = { 早上: 9, 上午: 9, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 夜晚: 20 };
const DOW = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/**
 * 解析「[日期][星期] [時段] <時間> <內容>」→ { remindAt: Date, content, dated, defaultedTime } | null
 * 支援：18:00 開會 / 明天 09:00 X / 7/1（三）下午5:15維鈞牙醫 / 晚上6:20東區衛生所 /
 *       11月25日 X / 週三 X / 下週五 X / 30分鐘後 X / 2小時後 X（內容可黏在時間後面）
 * opts.defaultTime：true＝有給日期但沒給幾點時，用早上 9:00（或時段詞的預設，例如「晚上」20:00）
 */
export function parseReminder(input, opts = {}) {
  let s = normalize(input).trim();
  let m;
  const now = opts.now ? new Date(opts.now) : nowTW();

  // 相對時間
  if ((m = s.match(/^(\d+)\s*分鐘?後\s*(.+)$/))) return { remindAt: new Date(now.getTime() + (+m[1]) * 60000), content: m[2].trim(), dated: false };
  if ((m = s.match(/^(\d+)\s*(?:個)?(?:小時|時)後\s*(.+)$/))) return { remindAt: new Date(now.getTime() + (+m[1]) * 3600000), content: m[2].trim(), dated: false };

  let year = now.getFullYear(), mon = now.getMonth() + 1, day = now.getDate();
  let dateMode = 'none';

  // 去星期註記：（三）(二)（週五）（星期一）
  s = s.replace(/[（(]\s*(?:週|星期|禮拜)?[一二三四五六日天]\s*[）)]/g, ' ').trim();

  const setDay = (d) => { year = d.getFullYear(); mon = d.getMonth() + 1; day = d.getDate(); };
  // 相對日、M/D、M月D日、（下）週X
  if ((m = s.match(/^(今天|明天|後天)\s*/))) {
    const add = m[1] === '明天' ? 1 : m[1] === '後天' ? 2 : 0;
    const d = new Date(now); d.setDate(d.getDate() + add); setDay(d);
    dateMode = 'rel'; s = s.slice(m[0].length).trim();
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})(?![\d/])\s*/)) || (m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?\s*/))) {
    mon = +m[1]; day = +m[2]; dateMode = 'md'; s = s.slice(m[0].length).trim();
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  } else if ((m = s.match(/^(下(?:個)?|這(?:個)?|本)?\s*(?:週|星期|禮拜)([一二三四五六日天])\s*/))) {
    const target = DOW[m[2]];
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (m[1] && m[1].startsWith('下')) {
      const mondayOffset = (d.getDay() + 6) % 7;            // 本週一往回幾天
      d.setDate(d.getDate() - mondayOffset + 7 + ((target + 6) % 7)); // 下週一 + 目標
    } else {
      d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7)); // 這週（今天以後最近的那天）
    }
    setDay(d);
    dateMode = 'rel'; s = s.slice(m[0].length).trim();
  }

  // 時段詞（下午/晚上/上午…）
  let part = null, partWord = null;
  if ((m = s.match(/^(凌晨|早上|上午|中午|下午|晚上|傍晚|夜晚)\s*/))) { partWord = m[1]; part = PART[m[1]]; s = s.slice(m[0].length).trim(); }

  // 時間 H:MM / H點MM分 / H點半 / H點（內容可緊接其後）
  let hour, min, defaultedTime = false;
  if ((m = s.match(/^(\d{1,2})\s*(?::\s*(\d{1,2})|點\s*(半|\d{1,2})?\s*分?)/))) {
    hour = +m[1];
    min = m[2] != null ? +m[2] : m[3] === '半' ? 30 : m[3] != null ? +m[3] : 0;
    s = s.slice(m[0].length).trim();
    if (part === 'pm' && hour < 12) hour += 12;
    else if (part === 'am' && hour === 12) hour = 0;
    else if (part === 'noon' && hour < 12 && hour !== 0) hour = hour <= 2 ? hour + 12 : 12;
  } else if (opts.defaultTime && dateMode !== 'none') {
    hour = PART_DEFAULT[partWord] ?? DEFAULT_TIME.h; min = DEFAULT_TIME.m; defaultedTime = true;
  } else return null;
  if (hour > 23 || min > 59) return null;

  const content = s.replace(/^[，,、:\s]+/, '').trim();
  if (!content) return null;

  let d = new Date(year, mon - 1, day, hour, min, 0);
  if (dateMode === 'none' && d <= now) d = new Date(year, mon - 1, day + 1, hour, min, 0); // 沒給日期、已過 → 明天
  if (dateMode === 'md' && d <= now && new Date(year, mon - 1, day + 1) <= now) d = new Date(year + 1, mon - 1, day, hour, min, 0); // 給 M/D 且整天都過了 → 明年
  return { remindAt: d, content, dated: dateMode !== 'none', defaultedTime }; // dated=有明確給日期（明天/後天/M/D/週X）
}

// 口語「小帥 提醒我 11/25 ○○」「明天 9 點提醒大家交報告」整理成「日期 時間 內容」（小帥用）
const REMIND_WORD_RE = /(?:請|幫我|麻煩|記得|要)?\s*提醒(?:一下)?\s*(?:我們|我|大家|全家|你們|各位|一下)?\s*(?:要|記得|說)?\s*/;
/** 把句子整理成 remind 的格式：去掉叫小帥、去掉「提醒我」，剩「日期 時間 內容」；不像設提醒回 null */
export function remindSpecOf(text) {
  let t = String(text || '').normalize('NFKC').trim();
  t = t.replace(/^@?小帥[，,、:\s]*/, '').trim();
  if (!REMIND_WORD_RE.test(t)) return null;
  if (/[?？嗎]\s*$/.test(t) || /(謝謝|感謝|多謝).{0,4}提醒/.test(t)) return null; // 問句、道謝不是要設提醒
  const spec = t.replace(REMIND_WORD_RE, ' ').replace(/^[，,、:\s]+/, '').replace(/\s+/g, ' ').trim()
    .replace(/^小帥[，,、:\s]*/, '').replace(/[。!！]+$/, '').trim();
  return spec || null;
}
// 待提醒（某 scope 的某人）
function myPending(userId) {
  return db.all(
    `SELECT id, content, remind_at, mode, due FROM reminders WHERE user_id = ? AND fired = 0 ORDER BY remind_at`,
    userId
  );
}

const hhmm = (d) => new Date(d).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

// 「該提醒了」的時間：morning（有日期的事件）→ 事件前 30 分；exact → 就是該時間
function pingTimeOf(r) {
  const ev = new Date(r.remind_at);
  return (r.mode || 'exact') === 'morning' ? new Date(ev.getTime() - 30 * 60000) : ev;
}
// morning 的「今天有這件事」預告：事件當天早上 7:00 起
function digestTimeOf(r) {
  const ev = new Date(r.remind_at);
  return new Date(ev.getFullYear(), ev.getMonth(), ev.getDate(), 7, 0, 0);
}

/** 時間到：只標成已到期、待送（不推播），等下一次回覆帶出去 */
function markDue(id) {
  db.run('UPDATE reminders SET due = 1 WHERE id = ? AND fired = 0', id);
}
function schedule(r) {
  scheduler.addOnce(`remind-${r.id}`, pingTimeOf(r), async () => {
    markDue(r.id);
    console.log(`[remind] #${r.id} 到期，等 ${String(r.scope_id).slice(0, 8)}... 有人說話時一起回覆`);
  }, { plugin: 'remind' });
}

// 有未來日期且有給幾點 → 早上預告＋事件前 30 分（morning）；當天/相對/只給日期 → 準時（exact）
function computeMode(parsed) {
  if (parsed.defaultedTime) return 'exact';
  const today = dayKey(new Date());
  const rd = dayKey(parsed.remindAt);
  return (parsed.dated && rd > today) ? 'morning' : 'exact';
}

/**
 * 寫入一筆提醒 + 排程，回傳 { id, content, when, mode }
 * ctx：{ userId, scopeId }；opts.mode 可指定 'exact'／'morning'
 */
export function createReminder(ctx, parsed, addedBy = '', opts = {}) {
  if (!db) throw new Error('remind 沒有資料庫');
  const mode = opts.mode || computeMode(parsed);
  const result = db.run(
    `INSERT INTO reminders (user_id, scope_id, added_by, content, remind_at, mode, fired, due, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, datetime('now','+8 hours'))`,
    ctx.userId, ctx.scopeId, addedBy, parsed.content, parsed.remindAt.toISOString(), mode
  );
  const id = Number(result.lastInsertRowid);
  if (scheduler) schedule({ id, scope_id: ctx.scopeId, added_by: addedBy, content: parsed.content, remind_at: parsed.remindAt.toISOString(), mode });
  const when = mode === 'morning' ? `${fmt(parsed.remindAt)}（當天早上 7 點起先預告，事件前 30 分再提醒）` : fmt(parsed.remindAt);
  return { id, content: parsed.content, when, mode, remindAt: parsed.remindAt };
}

/**
 * 口語設提醒（小帥用）：「11/25 日本行前待辦」「明天 9 點交報告」→ 建立；只給日期沒給時間用早上 9:00
 * 回 { ok: true, id, content, when, defaultedTime } 或 { ok: false, reason: 'parse'|'past'|'nodb' }
 */
export function createReminderFromText({ userId, scopeId, addedBy = '', text, now }) {
  if (!db) return { ok: false, reason: 'nodb' };
  const parsed = parseReminder(text, { defaultTime: true, now });
  if (!parsed) return { ok: false, reason: 'parse' };
  if (parsed.remindAt <= (now ? new Date(now) : nowTW())) return { ok: false, reason: 'past', remindAt: parsed.remindAt };
  const r = createReminder({ userId, scopeId }, parsed, addedBy);
  return { ok: true, ...r, defaultedTime: parsed.defaultedTime };
}

// ── 到期提醒併進回覆（core/reply-extras.js 會來問） ──────────────

/** 這個聊天現在該送出的提醒：[{ row, kind: 'ping'|'digest' }] */
export function dueFor(scopeId, now = Date.now()) {
  if (!db || !scopeId) return [];
  const rows = db.all('SELECT * FROM reminders WHERE scope_id = ? AND fired = 0 ORDER BY remind_at', scopeId);
  const out = [];
  for (const r of rows) {
    if (inflight.has(r.id)) continue;
    if (pingTimeOf(r).getTime() <= now || r.due) out.push({ row: r, kind: 'ping' });
    else if ((r.mode || 'exact') === 'morning' && !r.morning_done && digestTimeOf(r).getTime() <= now) out.push({ row: r, kind: 'digest' });
  }
  return out;
}

/** 到期的提醒做成一則訊息（多筆合併成一張卡） */
export function dueMessage(items, now = Date.now()) {
  const lines = [];
  for (const { row: r, kind } of items) {
    const ev = new Date(r.remind_at);
    const who = r.added_by ? `（${r.added_by} 設的）` : '';
    let line;
    if (kind === 'digest') line = `今天 ${hhmm(ev)}　${r.content}`;
    else if ((r.mode || 'exact') === 'morning') {
      line = now > ev.getTime() + LATE_MS ? `${r.content}（原定 ${fmt(ev)}）` : `${hhmm(ev)}　${r.content}`;
    } else {
      line = now - ev.getTime() > LATE_MS ? `${r.content}（原定 ${fmt(ev)}）` : r.content;
    }
    lines.push(`${items.length > 1 ? '• ' : ''}${line}${who}`);
  }
  const body = lines.join('\n');
  const msg = flex.card({ title: items.length > 1 ? `⏰ 提醒 · ${items.length} 件` : '⏰ 提醒', body, color: COLOR });
  msg.altText = `⏰ 提醒：${body}`.slice(0, 400);
  return msg;
}

/** 送出去了：ping → fired=1（也算預告過）；只送了預告 → morning_done=1 */
function commitDelivered(items) {
  for (const { row, kind } of items) {
    if (kind === 'digest') db.run('UPDATE reminders SET morning_done = 1 WHERE id = ?', row.id);
    else db.run("UPDATE reminders SET fired = 1, due = 1, morning_done = 1, delivered_at = datetime('now','+8 hours') WHERE id = ?", row.id);
    scheduler?.stop?.(`remind-${row.id}`);
  }
}

const squash = (s) => String(s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
/** 回覆內文裡已經有這件事（內容前 8 個字出現在回覆裡） */
export function coveredBy(baseText, content) {
  const c = squash(content);
  if (c.length < 4) return false;
  return squash(baseText).includes(c.slice(0, Math.min(8, c.length)));
}

export const replyProvider = {
  has: (scopeId) => dueFor(scopeId).length > 0,
  take: (scopeId, { baseText = '' } = {}) => {
    const items = dueFor(scopeId);
    if (!items.length) return null;
    // 同一次回覆裡已經講到的（例：今日行程有同一件事）不再講一次，送出後一樣算送過
    const fresh = items.filter(it => !coveredBy(baseText, it.row.content));
    for (const it of items) inflight.add(it.row.id);
    const release = () => { for (const it of items) inflight.delete(it.row.id); };
    return {
      messages: fresh.length ? [dueMessage(fresh)] : [],
      covered: fresh.length < items.length,
      commit: () => {
        try { commitDelivered(items); } finally { release(); }
        console.log(`[remind] ${String(scopeId).slice(0, 8)}... 用回覆送出提醒 ${items.length} 筆：${items.map(i => `#${i.row.id}${i.kind === 'digest' ? '(預告)' : ''}`).join(' ')}`);
      },
      release,
    };
  },
};

/** 測試用：換掉 db／scheduler／lineApi */
export function _setDeps(deps) {
  if ('db' in deps) db = deps.db;
  if ('scheduler' in deps) scheduler = deps.scheduler;
  if ('lineApi' in deps) lineApi = deps.lineApi;
  inflight.clear();
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      added_by TEXT,
      content TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      mode TEXT DEFAULT 'exact',
      fired INTEGER DEFAULT 0,
      morning_done INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  const cols = db.all('PRAGMA table_info(reminders)').map(c => c.name);
  if (!cols.includes('mode')) db.exec("ALTER TABLE reminders ADD COLUMN mode TEXT DEFAULT 'exact'");
  if (!cols.includes('morning_done')) db.exec('ALTER TABLE reminders ADD COLUMN morning_done INTEGER DEFAULT 0');
  if (!cols.includes('due')) db.exec('ALTER TABLE reminders ADD COLUMN due INTEGER DEFAULT 0');           // 1＝時間到了、等回覆帶出去
  if (!cols.includes('delivered_at')) db.exec('ALTER TABLE reminders ADD COLUMN delivered_at TEXT');     // 用回覆送出的時間
  db.exec('CREATE INDEX IF NOT EXISTS idx_remind_user ON reminders (user_id, fired)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_remind_scope ON reminders (scope_id, fired)');
}
export { ensureSchema as _ensureSchema };

export default {
  name: 'remind',
  scope: 'all',

  helpText: `⏰ 定時提醒 使用說明

設定（時間 + 內容）：
　/提醒 18:00 開會
　/提醒 明天 09:00 交報告
　/提醒 7/1（三）下午5:15 維鈞牙醫
　/提醒 晚上6:20 東區衛生所
　/提醒 30分鐘後 倒垃圾　/提醒 2小時後 回電
　（內容可緊接時間，不用空格；可加上下午/晚上/星期）
有開小帥的地方說「小帥 提醒我 11/25 交報告」→ 小帥記進行事曆（當天早上貼今日行程提醒）

看清單：/提醒
取消：/提醒取消 1（或點清單的 ✕）

🔸 不推播：${WAIT_NOTE}（跟那次回覆一起送）
🔸 有指定日期和時間（7/1 下午5:15）→ 當天早上 7:00 起先預告，事件前 30 分再提醒
🔸 當天/相對（今天某點、30分鐘後）→ 時間到就提醒
🔸 在群組設→提醒在群組；私訊設→提醒在私訊
🔸 很久沒人說話的，送出時會標「原定」時間；重啟不會掉`,

  commands: [
    // /提醒取消 <n>（放前面，避免被 /提醒 <內容> 吃掉）
    {
      name: 'cancel',
      pattern: /^\/提醒取消\s+(\d+)$/i,
      describe: '/提醒取消 <編號> — 取消提醒',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const n = +match[1];
        const r = myPending(ctx.userId)[n - 1];
        if (!r) return `❌ 找不到第 ${n} 筆`;
        scheduler.stop(`remind-${r.id}`);
        db.run('DELETE FROM reminders WHERE id = ?', r.id);
        return `🗑️ 已取消提醒：${r.content}`;
      },
    },
    // /提醒（裸）→ 清單
    {
      name: 'list',
      pattern: /^\/提醒$/i,
      describe: '/提醒 — 看待提醒清單',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const rows = myPending(ctx.userId);
        if (!rows.length) return '⏰ 沒有待提醒\n用 /提醒 18:00 開會 設定';
        const body = [
          { type: 'text', text: `⏰ 待提醒 · ${rows.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
          { type: 'separator', margin: 'md', color: '#f1f5f9' },
        ];
        rows.forEach((r, i) => {
          if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
          const late = r.due || pingTimeOf(r) <= new Date();
          body.push({
            type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
                contents: [
                  { type: 'text', text: r.content, size: 'md', color: '#1e293b', weight: 'bold', wrap: true },
                  { type: 'text', text: `${fmt(r.remind_at)}${late ? '（已到期，有人說話時送出）' : ''}`, size: 'xs', color: '#94a3b8', wrap: true },
                ],
              },
              {
                type: 'box', layout: 'vertical', width: '30px',
                action: { type: 'message', label: '取消', text: `/提醒取消 ${i + 1}` },
                contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
              },
            ],
          });
        });
        return { type: 'flex', altText: '待提醒', contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body } } };
      },
    },
    // /提醒 <時間> <內容> → 設定（[\s\S] 才能跨行：一則訊息多行 = 多筆提醒）
    {
      name: 'set',
      pattern: /^\/提醒\s+([\s\S]+)$/i,
      describe: '/提醒 <時間> <內容> — 設定定時提醒',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';

        // 支援一則訊息多行，每行一個 /提醒；單行則退回整段參數
        const raw = ctx.event?.message?.text ?? `/提醒 ${match[1]}`;
        const specs = [];
        for (const line of raw.split(/\r?\n/)) {
          const mm = line.trim().match(/^\/提醒\s+(.+)$/i);
          if (mm) specs.push(mm[1].trim());
        }
        if (!specs.length) specs.push(match[1].trim());

        let addedBy = '';
        if (ctx.groupId) {
          try { const p = await ctx.lineApi.getGroupMemberProfile(ctx.groupId, ctx.userId); addedBy = p?.displayName || ''; } catch { /* ignore */ }
        }

        const ok = [], bad = [];
        for (const spec of specs) {
          const parsed = parseReminder(spec, { defaultTime: true });
          if (!parsed) { bad.push(spec); continue; }
          if (parsed.remindAt <= nowTW()) { bad.push(`${spec}（時間已過）`); continue; }
          ok.push({ ...createReminder(ctx, parsed, addedBy), defaultedTime: parsed.defaultedTime });
        }

        if (!ok.length) {
          return '看不懂時間格式 🤔\n例：\n/提醒 18:00 開會\n/提醒 明天 09:00 交報告\n/提醒 30分鐘後 倒垃圾';
        }

        const nineNote = ok.some(o => o.defaultedTime) ? '\n（沒講幾點的排早上 9:00）' : '';
        // 單筆 → 卡片；多筆 → 條列摘要
        if (ok.length === 1 && !bad.length) {
          return flex.mini({
            icon: '⏰', title: '已設定提醒', accent: COLOR,
            body: `${ok[0].content}\n📅 ${ok[0].when}${nineNote}\n${WAIT_NOTE}`,
            actions: [{ label: '看待提醒', text: '/提醒' }],
          });
        }
        const lines = [];
        for (const o of ok) lines.push(`• ${o.content}\n　📅 ${o.when}`);
        if (bad.length) { lines.push('', `⚠️ 看不懂 ${bad.length} 筆：`); for (const b of bad) lines.push(`• ${b}`); }
        lines.push('', `${WAIT_NOTE}${nineNote}`);
        return flex.card({ title: `已設定 ${ok.length} 筆提醒`, body: lines.join('\n'), color: COLOR });
      },
    },
  ],

  /** 群組裡確定沒人要回的訊息（貼圖、照片、沒命中的話）：有到期提醒就用這則的回覆送出 */
  async onIdleReply({ chatId, replyToken }) {
    if (!db || !chatId || !replyToken || !replyProvider.has(chatId)) return false;
    // 小帥會用這則回覆貼查好的答案／今日行程（held_answers）：讓它送，提醒由 reply-extras 併進同一次回覆
    if (lineApi?.idleOwnedElsewhere?.(chatId, 'remind')) return false;
    try {
      const r = await lineApi.reply(replyToken, []); // 只送附帶的（reply-extras 會帶上到期提醒）
      return !r?.skipped;
    } catch (err) {
      console.warn(`[remind] 用閒置回覆送提醒失敗（留著下次）：${err.message}`);
      return false;
    }
  },

  init: async (ctx) => {
    db = ctx.db;
    scheduler = ctx.scheduler;
    lineApi = ctx.lineApi;
    if (!db) { console.warn('[remind] no db — disabled'); return; }

    ensureSchema();

    // 到期提醒一律跟著回覆送（core/reply-extras.js）
    if (lineApi?.addReplyExtra) lineApi.addReplyExtra('remind', replyProvider);
    else console.warn('[remind] lineApi 沒有 addReplyExtra（core/reply-extras.js 沒掛上），到期提醒送不出去');

    // 重啟恢復：還沒到的重新排；已經到期的只標 due，等有人說話時一起回覆（不補推播）
    const pending = db.all('SELECT * FROM reminders WHERE fired = 0');
    let restored = 0, due = 0;
    for (const r of pending) {
      if (pingTimeOf(r) > new Date()) { schedule(r); restored++; }
      else { markDue(r.id); due++; }
    }
    if (restored || due) console.log(`[remind] restored ${restored}, due-waiting ${due}`);
    console.log('[remind] ready（到期提醒用回覆送，不推播）');
  },
};
