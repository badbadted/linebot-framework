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

// ── 位置序號解析（畫面顯示 1,2,3… 連號，不用資料庫 id） ──
function getUndoneTodos(userId) {
  return db.all(
    `SELECT id, content, done, remind_at FROM todos
     WHERE user_id = ? AND done = 0
     ORDER BY id`,
    userId
  );
}

// 第 n 筆（從畫面看到的序號）→ 實際資料列
function todoByIndex(userId, n) {
  return getUndoneTodos(userId)[n - 1] || null;
}

// ── 互動式待辦清單（簡約式：單色、極細分隔、右側 ✓ ✕ 小圖示） ──
function buildTodoList(todos) {
  const MAX = 12; // 避免 Flex bubble 過大
  const shown = todos.slice(0, MAX);

  const body = [
    { type: 'text', text: `待辦 · ${todos.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];

  shown.forEach((t, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });

    const pos = i + 1; // 畫面序號（連號），按鈕也用這個
    const left = {
      type: 'box', layout: 'horizontal', flex: 1, spacing: 'sm', alignItems: 'center',
      contents: [
        { type: 'text', text: String(pos), size: 'sm', color: '#94a3b8', flex: 0 },
        { type: 'text', text: t.content, size: 'md', color: '#1e293b', flex: 1, wrap: false },
      ],
    };
    if (t.remind_at) {
      left.contents.push({ type: 'text', text: formatTime(t.remind_at), size: 'xs', color: '#94a3b8', flex: 0, align: 'end' });
    }

    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
      paddingTop: 'md', paddingBottom: 'md',
      contents: [
        left,
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '完成', text: `/todo_done ${pos}` },
          contents: [{ type: 'text', text: '✓', size: 'lg', align: 'center', color: '#10b981' }],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '刪除', text: `/todo_del ${pos}` },
          contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
        },
      ],
    });
  });

  if (todos.length > MAX) {
    body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push({ type: 'text', text: `還有 ${todos.length - MAX} 筆`, size: 'xxs', color: '#94a3b8', align: 'center', margin: 'md' });
  }

  return {
    type: 'flex',
    altText: '待辦列表',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body },
    },
  };
}

// ── 新增待辦（共用：/todo_add 與 /todo <內容> 都用這個） ──
function addTodo(content, userId) {
  const text = content.trim();
  db.run(
    `INSERT INTO todos (user_id, content, done, created_at)
     VALUES (?, ?, 0, datetime('now', '+8 hours'))`,
    userId, text
  );
  const count = getUndoneTodos(userId).length; // 新增後的未完成筆數 = 此筆序號
  return flex.card({
    title: '✅ 已新增待辦',
    body: `${count}　${text}`,
    color: '#10b981',
    actions: [{ label: '查看列表', text: '/todo' }],
  });
}

// ── 建立提醒排程 ─────────────────────────────────────
function scheduleReminder(id, userId, content, remindAt) {
  scheduler.addOnce(`todo-remind-${id}`, remindAt, async ({ lineApi }) => {
    // 觸發當下才算位置序號（清單可能已增減）
    const pos = getUndoneTodos(userId).findIndex(t => t.id === id) + 1;
    await lineApi.push(userId, flex.card({
      title: '⏰ 待辦提醒',
      body: content,
      color: '#f59e0b',
      actions: pos > 0 ? [{ label: '已完成', text: `/todo_done ${pos}` }] : [],
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
      describe: '/todo <內容> — 新增待辦',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        return addTodo(match[1], ctx.userId);
      },
    },
    {
      // /todo <內容>（空格新增，跟 /旅遊 /加美 一致）
      name: 'add-todo-bare',
      pattern: /^\/todo\s+(.+)$/i,
      describe: '/todo <內容> — 新增待辦',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        return addTodo(match[1], ctx.userId);
      },
    },
    {
      name: 'list-todos',
      command: 'list',
      describe: '/todo — 顯示待辦清單',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const todos = getUndoneTodos(ctx.userId);
        if (!todos.length) return '📋 沒有待辦事項！輸入 /todo_add 建立';

        return buildTodoList(todos);
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
        const n = +match[1];
        const todo = todoByIndex(ctx.userId, n);
        if (!todo) return `❌ 找不到第 ${n} 筆`;
        db.run('UPDATE todos SET done = 1 WHERE id = ?', todo.id);
        scheduler.stop(`todo-remind-${todo.id}`);
        return `✅ 已完成：${todo.content}`;
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
        const n = +match[1];
        const todo = todoByIndex(ctx.userId, n);
        if (!todo) return `❌ 找不到第 ${n} 筆`;
        db.run('DELETE FROM todos WHERE id = ?', todo.id);
        scheduler.stop(`todo-remind-${todo.id}`);
        return `🗑️ 已刪除：${todo.content}`;
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
        const n = +match[1];
        const newContent = match[2].trim();
        const todo = todoByIndex(ctx.userId, n);
        if (!todo) return `❌ 找不到第 ${n} 筆`;
        db.run('UPDATE todos SET content = ? WHERE id = ?', newContent, todo.id);
        return `📝 已修改第 ${n} 筆：${newContent}`;
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
        const n = +match[1];
        const timeText = match[2].trim();
        const todo = todoByIndex(ctx.userId, n);
        if (!todo) return `❌ 找不到第 ${n} 筆`;

        const remindAt = parseRemindTime(timeText);
        if (!remindAt) return '❌ 時間格式錯誤\n支援：18:00 / 明天 09:00 / 12/25 10:00';

        db.run('UPDATE todos SET remind_at = ? WHERE id = ?',
          remindAt.toISOString(), todo.id);

        // 取消舊提醒，建立新提醒
        scheduler.stop(`todo-remind-${todo.id}`);
        scheduleReminder(todo.id, ctx.userId, todo.content, remindAt);

        return `⏰ 已設定提醒\n${todo.content}\n📅 ${formatTime(remindAt.toISOString())}`;
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
