/**
 * Todo Plugin — 待辦記錄 + 定時提醒
 *
 * 前綴：/todo
 *
 * 指令：
 *   /todo_add 買牛奶          → 建立待辦
 *   /todo                     → 顯示未完成清單
 *   /todo_done 1              → 標記 #1 完成
 *   /todo_del 1               → 刪除 #1
 *   /todo_edit 1 買豆漿       → 修改 #1 內容
 *   /todo_remind 1 18:00      → 今天 18:00 提醒
 *   /todo_remind 1 明天 09:00 → 明天 09:00 提醒
 *
 * 排程：
 *   每天早上 9 點推播未完成待辦摘要
 *
 * 需求 Provider：db（SQLite）
 */

import { flex } from '../../src/utils/flex.js';

let db, scheduler;

// ── 時間解析 ─────────────────────────────────────────
function parseRemindTime(text) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));

  // "18:00" → 今天 18:00（過了就排明天）
  const todayMatch = text.match(/^(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(+todayMatch[1], +todayMatch[2], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  // "明天 09:00"
  const tomorrowMatch = text.match(/^明天\s*(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(+tomorrowMatch[1], +tomorrowMatch[2], 0, 0);
    return d;
  }

  // "12/25 10:00"
  const dateMatch = text.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (dateMatch) {
    return new Date(now.getFullYear(), +dateMatch[1] - 1, +dateMatch[2], +dateMatch[3], +dateMatch[4]);
  }

  return null;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

// ── 建立提醒排程 ─────────────────────────────────────
function scheduleReminder(id, userId, content, remindAt) {
  scheduler.addOnce(`todo-remind-${id}`, remindAt, async ({ lineApi }) => {
    await lineApi.push(userId, flex.card({
      title: '⏰ 待辦提醒',
      body: `#${id}  ${content}`,
      color: '#f59e0b',
      actions: [{ label: '已完成', text: `/todo_done ${id}` }],
    }));
  });
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'todo',
  prefix: 'todo',
  defaultCommand: 'list-todos',
  scope: 'all',  // 群組和私訊都可用，資料以 userId 區分

  commands: [
    {
      name: 'add-todo',
      command: 'add',
      pattern: /^(.+)/,
      describe: '/todo_add <內容> — 新增待辦',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const content = match[1].trim();
        const result = db.run(
          `INSERT INTO todos (user_id, content, done, created_at)
           VALUES (?, ?, 0, datetime('now', '+8 hours'))`,
          ctx.userId, content
        );
        const id = result.lastInsertRowid;
        return flex.card({
          title: '✅ 已新增待辦',
          body: `#${id}  ${content}`,
          color: '#10b981',
          actions: [
            { label: '查看列表', text: '/todo' },
          ],
        });
      },
    },
    {
      name: 'list-todos',
      command: 'list',
      describe: '/todo — 顯示待辦清單',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const todos = db.all(
          `SELECT id, content, done, remind_at FROM todos
           WHERE user_id = ? AND done = 0
           ORDER BY id`,
          ctx.userId
        );
        if (!todos.length) return '📋 沒有待辦事項！輸入 /todo_add 建立';

        return flex.list('📋 待辦列表', todos.map(t => ({
          label: `#${t.id}  ${t.content}`,
          value: t.remind_at ? `⏰ ${formatTime(t.remind_at)}` : '',
        })));
      },
    },
    {
      name: 'done-todo',
      command: 'done',
      pattern: /^(\d+)$/,
      describe: '/todo_done <編號> — 標記完成',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const todo = db.get(
          'SELECT * FROM todos WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!todo) return `❌ 找不到 #${id}`;
        db.run('UPDATE todos SET done = 1 WHERE id = ?', id);
        scheduler.stop(`todo-remind-${id}`);
        return `✅ 已完成：#${id} ${todo.content}`;
      },
    },
    {
      name: 'delete-todo',
      command: 'del',
      pattern: /^(\d+)$/,
      describe: '/todo_del <編號> — 刪除待辦',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const todo = db.get(
          'SELECT * FROM todos WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!todo) return `❌ 找不到 #${id}`;
        db.run('DELETE FROM todos WHERE id = ?', id);
        scheduler.stop(`todo-remind-${id}`);
        return `🗑️ 已刪除：#${id} ${todo.content}`;
      },
    },
    {
      name: 'edit-todo',
      command: 'edit',
      pattern: /^(\d+)\s+(.+)/,
      describe: '/todo_edit <編號> <新內容> — 修改待辦',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const newContent = match[2].trim();
        const todo = db.get(
          'SELECT * FROM todos WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!todo) return `❌ 找不到 #${id}`;
        db.run('UPDATE todos SET content = ? WHERE id = ?', newContent, id);
        return `📝 已修改 #${id}：${newContent}`;
      },
    },
    {
      name: 'remind-todo',
      command: 'remind',
      pattern: /^(\d+)\s+(.+)/,
      describe: '/todo_remind <編號> <時間> — 設定提醒',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const timeText = match[2].trim();
        const todo = db.get(
          'SELECT * FROM todos WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!todo) return `❌ 找不到 #${id}`;

        const remindAt = parseRemindTime(timeText);
        if (!remindAt) return '❌ 時間格式錯誤\n支援：18:00 / 明天 09:00 / 12/25 10:00';

        db.run('UPDATE todos SET remind_at = ? WHERE id = ?',
          remindAt.toISOString(), id);

        // 取消舊提醒，建立新提醒
        scheduler.stop(`todo-remind-${id}`);
        scheduleReminder(id, ctx.userId, todo.content, remindAt);

        return `⏰ 已設定提醒\n#${id} ${todo.content}\n📅 ${formatTime(remindAt.toISOString())}`;
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    scheduler = ctx.scheduler;

    if (!db) {
      console.warn('[todo] no db provider — todo storage disabled');
      return;
    }

    // 建表
    db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        done INTEGER DEFAULT 0,
        remind_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_todos_user ON todos (user_id, done)');

    // 重啟時恢復未觸發的提醒
    const pending = db.all(
      `SELECT id, user_id, content, remind_at FROM todos
       WHERE done = 0 AND remind_at IS NOT NULL AND remind_at > datetime('now')`
    );
    for (const t of pending) {
      scheduleReminder(t.id, t.user_id, t.content, new Date(t.remind_at));
    }
    if (pending.length) {
      console.log(`[todo] restored ${pending.length} pending reminders`);
    }
  },
};
