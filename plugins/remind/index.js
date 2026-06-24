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
 * 範圍：在哪設就推到哪（群組→群組、私訊→你）。重啟自動恢復、過期補推。
 * 需求 Provider：db（SQLite）+ scheduler
 */

import { flex } from '../../src/utils/flex.js';

let db, scheduler, lineApi;
const COLOR = '#f59e0b'; // 琥珀

// 「現在」這個瞬間與時區無關，直接用 new Date()——原本的 toLocaleString round-trip 在非台北主機會
// 把牆鐘字串用伺服器本地時區誤判，導致所有提醒偏移數小時。
// 注意：下方絕對時間分支（setHours / new Date(y,mo,d,...)）以伺服器本地時區建構牆鐘時間，
// 假設部署主機時區為 Asia/Taipei（台灣固定 UTC+8、無日光節約）；若改部署到非台北主機需改用具時區能力的方式建構。
function nowTW() {
  return new Date();
}
function fmt(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
function normalize(s) {
  return String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

// 時段詞 → am / pm / noon
const PART = { 凌晨: 'am', 早上: 'am', 上午: 'am', 中午: 'noon', 下午: 'pm', 晚上: 'pm', 傍晚: 'pm', 夜晚: 'pm' };

/**
 * 解析「[日期][星期] [時段] <時間> <內容>」→ { remindAt: Date, content } | null
 * 支援：18:00 開會 / 明天 09:00 X / 7/1（三）下午5:15維鈞牙醫 / 晚上6:20東區衛生所 /
 *       30分鐘後 X / 2小時後 X（內容可黏在時間後面）
 */
function parseReminder(input) {
  let s = normalize(input).trim();
  let m;

  // 相對時間
  if ((m = s.match(/^(\d+)\s*分鐘?後\s*(.+)$/))) return { remindAt: new Date(Date.now() + (+m[1]) * 60000), content: m[2].trim() };
  if ((m = s.match(/^(\d+)\s*(?:小時|時)後\s*(.+)$/))) return { remindAt: new Date(Date.now() + (+m[1]) * 3600000), content: m[2].trim() };

  const now = nowTW();
  let year = now.getFullYear(), mon = now.getMonth() + 1, day = now.getDate();
  let dateMode = 'none';

  // 去星期註記：（三）(二)（週五）（星期一）
  s = s.replace(/[（(]\s*(?:週|星期|禮拜)?[一二三四五六日天]\s*[）)]/g, ' ').trim();

  // 相對日 或 M/D
  if ((m = s.match(/^(今天|明天|後天)\s*/))) {
    const add = m[1] === '明天' ? 1 : m[1] === '後天' ? 2 : 0;
    const d = new Date(now); d.setDate(d.getDate() + add);
    year = d.getFullYear(); mon = d.getMonth() + 1; day = d.getDate();
    dateMode = 'rel'; s = s.slice(m[0].length).trim();
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\s*/))) {
    mon = +m[1]; day = +m[2]; dateMode = 'md'; s = s.slice(m[0].length).trim();
  }

  // 時段詞（下午/晚上/上午…）
  let part = null;
  if ((m = s.match(/^(凌晨|早上|上午|中午|下午|晚上|傍晚|夜晚)\s*/))) { part = PART[m[1]]; s = s.slice(m[0].length).trim(); }

  // 時間 H:MM / H：MM / H點MM分 / H點（內容可緊接其後）
  if (!(m = s.match(/^(\d{1,2})\s*[:：點]\s*(\d{1,2})?\s*分?/))) return null;
  let hour = +m[1]; const min = m[2] != null ? +m[2] : 0;
  s = s.slice(m[0].length).trim();

  // 套用時段
  if (part === 'pm' && hour < 12) hour += 12;
  else if (part === 'am' && hour === 12) hour = 0;
  else if (part === 'noon') hour = 12;
  if (hour > 23 || min > 59) return null;

  const content = s.trim();
  if (!content) return null;

  let d = new Date(year, mon - 1, day, hour, min, 0);
  if (dateMode === 'none' && d <= now) d = new Date(year, mon - 1, day + 1, hour, min, 0); // 沒給日期、已過 → 明天
  if (dateMode === 'md' && d <= now) d = new Date(year + 1, mon - 1, day, hour, min, 0);   // 給 M/D 已過 → 明年
  return { remindAt: d, content };
}

// 待提醒（某 scope 的某人）
function myPending(userId) {
  return db.all(
    `SELECT id, content, remind_at FROM reminders WHERE user_id = ? AND fired = 0 ORDER BY remind_at`,
    userId
  );
}

function schedule(r) {
  scheduler.addOnce(`remind-${r.id}`, new Date(r.remind_at), async () => {
    const who = r.added_by ? `\n— ${r.added_by}` : '';
    try {
      await lineApi.push(r.scope_id, flex.card({ title: '⏰ 提醒', body: `${r.content}${who}`, color: COLOR }));
    } catch (err) { console.error(`[remind] push error: ${err.message}`); }
    db.run('UPDATE reminders SET fired = 1 WHERE id = ?', r.id);
  });
}

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

看清單：/提醒
取消：/提醒取消 1（或點清單的 ✕）

🔸 在群組設→提醒到群組；私訊設→提醒給你
🔸 重啟不會掉、過期會補推`,

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
          body.push({
            type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
            contents: [
              {
                type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
                contents: [
                  { type: 'text', text: r.content, size: 'md', color: '#1e293b', weight: 'bold', wrap: true },
                  { type: 'text', text: fmt(r.remind_at), size: 'xs', color: '#94a3b8' },
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
    // /提醒 <時間> <內容> → 設定
    {
      name: 'set',
      pattern: /^\/提醒\s+(.+)$/i,
      describe: '/提醒 <時間> <內容> — 設定定時提醒',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const parsed = parseReminder(match[1]);
        if (!parsed) {
          return '看不懂時間格式 🤔\n例：\n/提醒 18:00 開會\n/提醒 明天 09:00 交報告\n/提醒 30分鐘後 倒垃圾';
        }
        if (parsed.remindAt <= nowTW()) return '提醒時間已經過了，請給未來的時間';

        let addedBy = '';
        if (ctx.groupId) {
          try { const p = await ctx.lineApi.getGroupMemberProfile(ctx.groupId, ctx.userId); addedBy = p?.displayName || ''; } catch { /* ignore */ }
        }
        const result = db.run(
          `INSERT INTO reminders (user_id, scope_id, added_by, content, remind_at, fired, created_at)
           VALUES (?, ?, ?, ?, ?, 0, datetime('now','+8 hours'))`,
          ctx.userId, ctx.scopeId, addedBy, parsed.content, parsed.remindAt.toISOString()
        );
        schedule({ id: result.lastInsertRowid, scope_id: ctx.scopeId, added_by: addedBy, content: parsed.content, remind_at: parsed.remindAt.toISOString() });
        return flex.mini({
          icon: '⏰', title: '已設定提醒', accent: COLOR,
          body: `${parsed.content}\n📅 ${fmt(parsed.remindAt)}`,
          actions: [{ label: '看待提醒', text: '/提醒' }],
        });
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    scheduler = ctx.scheduler;
    lineApi = ctx.lineApi;
    if (!db) { console.warn('[remind] no db — disabled'); return; }

    db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        added_by TEXT,
        content TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        fired INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_remind_user ON reminders (user_id, fired)');

    // 重啟恢復：未觸發的 → 未來的重新排程、過期的補推一次
    const pending = db.all('SELECT * FROM reminders WHERE fired = 0');
    let restored = 0, overdue = 0;
    for (const r of pending) {
      if (new Date(r.remind_at) > new Date()) { schedule(r); restored++; }
      else {
        const who = r.added_by ? `\n— ${r.added_by}` : '';
        lineApi.push(r.scope_id, flex.card({ title: '⏰ 提醒（補）', body: `${r.content}${who}`, color: COLOR })).catch(() => {});
        db.run('UPDATE reminders SET fired = 1 WHERE id = ?', r.id);
        overdue++;
      }
    }
    if (restored || overdue) console.log(`[remind] restored ${restored}, overdue-pushed ${overdue}`);
    console.log('[remind] ready');
  },
};
