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
      describe: '/work_add <內容> — 新增工作事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const content = match[1].trim();
        const result = db.run(
          `INSERT INTO work_items (user_id, content, done, created_at)
           VALUES (?, ?, 0, datetime('now', '+8 hours'))`,
          ctx.userId, content
        );
        const id = result.lastInsertRowid;
        return flex.card({
          title: '✅ 已記錄工作事項',
          body: `#${id}  ${content}`,
          color: '#6366f1',
          actions: [
            { label: '查看列表', text: '/work' },
          ],
        });
      },
    },
    {
      name: 'list-work',
      command: 'list',
      describe: '/work — 顯示工作事項',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = db.all(
          `SELECT id, content, done, created_at FROM work_items
           WHERE user_id = ? AND done = 0
           ORDER BY id`,
          ctx.userId
        );
        if (!items.length) return '📋 沒有進行中的工作事項！\n輸入 /work_add <內容> 新增';

        return flex.list('💼 工作事項', items.map(t => ({
          label: `#${t.id}  ${t.content}`,
          value: formatDate(t.created_at),
        })), '#6366f1');
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
        const id = +match[1];
        const item = db.get(
          'SELECT * FROM work_items WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!item) return `❌ 找不到 #${id}`;
        if (item.done) return `⚠️ #${id} 已經完成了`;
        db.run(
          `UPDATE work_items SET done = 1, done_at = datetime('now', '+8 hours') WHERE id = ?`,
          id
        );
        return `✅ 完成：#${id} ${item.content}`;
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
        const id = +match[1];
        const item = db.get(
          'SELECT * FROM work_items WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!item) return `❌ 找不到 #${id}`;
        db.run('DELETE FROM work_items WHERE id = ?', id);
        return `🗑️ 已刪除：#${id} ${item.content}`;
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
        const id = +match[1];
        const newContent = match[2].trim();
        const item = db.get(
          'SELECT * FROM work_items WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!item) return `❌ 找不到 #${id}`;
        db.run('UPDATE work_items SET content = ? WHERE id = ?', newContent, id);
        return `📝 已修改 #${id}：${newContent}`;
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
        for (const t of items) {
          const status = t.done ? '✅' : '⬜';
          const doneInfo = t.done && t.done_at ? ` (${formatDate(t.done_at)})` : '';
          lines.push(`${status} #${t.id}  ${t.content}${doneInfo}`);
        }

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
