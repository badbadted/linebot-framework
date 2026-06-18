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

function nowTW() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
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

/** 解析「<時間> <內容>」→ { remindAt: Date, content } | null */
function parseReminder(input) {
  const s = normalize(input).trim();
  let m;
  if ((m = s.match(/^(\d+)\s*分鐘?後\s+(.+)$/))) {
    return { remindAt: new Date(nowTW().getTime() + (+m[1]) * 60000), content: m[2].trim() };
  }
  if ((m = s.match(/^(\d+)\s*(?:小時|時)後\s+(.+)$/))) {
    return { remindAt: new Date(nowTW().getTime() + (+m[1]) * 3600000), content: m[2].trim() };
  }
  if ((m = s.match(/^明天\s*(\d{1,2}):(\d{2})\s+(.+)$/))) {
    const d = nowTW(); d.setDate(d.getDate() + 1); d.setHours(+m[1], +m[2], 0, 0);
    return { remindAt: d, content: m[3].trim() };
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s+(.+)$/))) {
    const now = nowTW();
    return { remindAt: new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]), content: m[5].trim() };
  }
  if ((m = s.match(/^(\d{1,2}):(\d{2})\s+(.+)$/))) {
    const d = nowTW(); d.setHours(+m[1], +m[2], 0, 0);
    if (d <= nowTW()) d.setDate(d.getDate() + 1);
    return { remindAt: d, content: m[3].trim() };
  }
  return null;
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
　/提醒 12/25 10:00 聖誕
　/提醒 30分鐘後 倒垃圾
　/提醒 2小時後 回電

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
