/**
 * Work Plugin — 工作事項記錄
 *
 * 前綴：/work
 *
 * 指令：
 *   /work_add 準備週會報告        → 建立工作事項
 *   /work                         → 顯示未完成清單
 *   /work_done 1                  → 標記 #1 完成
 *   /work_del 1                   → 刪除 #1
 *   /work_edit 1 更新週會報告     → 修改 #1 內容
 *   /work_all                     → 顯示全部（含已完成）
 *
 * 需求 Provider：db（SQLite）
 */

import { flex } from '../../src/utils/flex.js';

let db;

// ── 格式化 ──────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

const COLOR = '#6366f1'; // 靛紫

// ── 位置序號解析（畫面顯示 1,2,3… 連號，不用資料庫 id） ──
function getUndoneWork(userId) {
  return db.all(
    `SELECT id, content, done, created_at FROM work_items
     WHERE user_id = ? AND done = 0
     ORDER BY id`,
    userId
  );
}

function workByIndex(userId, n) {
  return getUndoneWork(userId)[n - 1] || null;
}

// ── 新增工作事項（共用：/work_add 與 /work <內容> 都用這個） ──
function addWork(content, userId) {
  const text = content.trim();
  db.run(
    `INSERT INTO work_items (user_id, content, done, created_at)
     VALUES (?, ?, 0, datetime('now', '+8 hours'))`,
    userId, text
  );
  return flex.mini({
    icon: '✓',
    title: '已記錄工作',
    body: text,
    accent: COLOR,
    actions: [{ label: '查看列表', text: '/work' }],
  });
}

// ── 互動式工作清單（簡約式：單色、極細分隔、右側 ✓ ✕ 小圖示） ──
function buildWorkList(items) {
  const MAX = 12;
  const shown = items.slice(0, MAX);

  const body = [
    { type: 'text', text: `工作 · ${items.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];

  shown.forEach((t, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    const pos = i + 1;
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
      paddingTop: 'md', paddingBottom: 'md',
      contents: [
        {
          type: 'box', layout: 'horizontal', flex: 1, spacing: 'sm', alignItems: 'center',
          contents: [
            { type: 'text', text: String(pos), size: 'sm', color: '#94a3b8', flex: 0 },
            { type: 'text', text: t.content, size: 'md', color: '#1e293b', flex: 1, wrap: false },
            { type: 'text', text: formatDate(t.created_at), size: 'xs', color: '#94a3b8', flex: 0, align: 'end' },
          ],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '完成', text: `/work_done ${pos}` },
          contents: [{ type: 'text', text: '✓', size: 'lg', align: 'center', color: '#10b981' }],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '刪除', text: `/work_del ${pos}` },
          contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
        },
      ],
    });
  });

  if (items.length > MAX) {
    body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push({ type: 'text', text: `還有 ${items.length - MAX} 筆`, size: 'xxs', color: '#94a3b8', align: 'center', margin: 'md' });
  }

  return {
    type: 'flex',
    altText: '工作事項',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body },
    },
  };
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'work',
  prefix: 'work',
  defaultCommand: 'list-work',
  scope: 'all',

  commands: [
    {
      name: 'add-work',
      command: 'add',
      pattern: /^(.+)/,
      describe: '/work <內容> — 新增工作事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        return addWork(match[1], ctx.userId);
      },
    },
    {
      // /work <內容>（空格新增，跟 /旅遊 /加美 一致）
      name: 'add-work-bare',
      pattern: /^\/work\s+(.+)$/i,
      describe: '/work <內容> — 新增工作事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        return addWork(match[1], ctx.userId);
      },
    },
    {
      name: 'list-work',
      command: 'list',
      describe: '/work — 顯示工作事項',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = getUndoneWork(ctx.userId);
        if (!items.length) return '📋 沒有進行中的工作事項！\n輸入 /work_add <內容> 新增';

        return buildWorkList(items);
      },
    },
    {
      name: 'done-work',
      command: 'done',
      pattern: /^(\d+)$/,
      describe: '/work_done <編號> — 標記完成',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const n = +match[1];
        const item = workByIndex(ctx.userId, n);
        if (!item) return `❌ 找不到第 ${n} 筆`;
        db.run(
          `UPDATE work_items SET done = 1, done_at = datetime('now', '+8 hours') WHERE id = ?`,
          item.id
        );
        return `✅ 完成：${item.content}`;
      },
    },
    {
      name: 'delete-work',
      command: 'del',
      pattern: /^(\d+)$/,
      describe: '/work_del <編號> — 刪除事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const n = +match[1];
        const item = workByIndex(ctx.userId, n);
        if (!item) return `❌ 找不到第 ${n} 筆`;
        db.run('DELETE FROM work_items WHERE id = ?', item.id);
        return `🗑️ 已刪除：${item.content}`;
      },
    },
    {
      name: 'edit-work',
      command: 'edit',
      pattern: /^(\d+)\s+(.+)/,
      describe: '/work_edit <編號> <新內容> — 修改事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const n = +match[1];
        const newContent = match[2].trim();
        const item = workByIndex(ctx.userId, n);
        if (!item) return `❌ 找不到第 ${n} 筆`;
        db.run('UPDATE work_items SET content = ? WHERE id = ?', newContent, item.id);
        return `📝 已修改第 ${n} 筆：${newContent}`;
      },
    },
    {
      name: 'all-work',
      command: 'all',
      describe: '/work_all — 顯示全部事項（含已完成）',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = db.all(
          `SELECT id, content, done, created_at, done_at FROM work_items
           WHERE user_id = ?
           ORDER BY done ASC, id DESC
           LIMIT 20`,
          ctx.userId
        );
        if (!items.length) return '📋 沒有工作事項記錄';

        const lines = ['💼 工作事項（全部）', ''];
        items.forEach((t, i) => {
          const status = t.done ? '✅' : '⬜';
          const doneInfo = t.done && t.done_at ? ` (${formatDate(t.done_at)})` : '';
          lines.push(`${status} ${i + 1}.  ${t.content}${doneInfo}`);
        });

        const pending = items.filter(t => !t.done).length;
        const completed = items.filter(t => t.done).length;
        lines.push('');
        lines.push(`📊 進行中 ${pending} / 已完成 ${completed}`);

        return lines.join('\n');
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;

    if (!db) {
      console.warn('[work] no db provider — work storage disabled');
      return;
    }

    // 建表
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        done INTEGER DEFAULT 0,
        done_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_work_user ON work_items (user_id, done)');
  },
};
