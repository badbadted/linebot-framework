/**
 * Work Plugin — 工作事項記錄
 *
 * 範圍（scope）：
 *   群組 → 全群共用一份清單（團隊看板，誰都能新增/完成/刪除）
 *   私訊 → 個人清單
 *   以 ctx.scopeId 區分（群組=groupId、私訊=userId）。群組內顯示每筆是誰加的。
 *
 * 指令：
 *   /work 準備週會報告        → 建立工作事項
 *   /work                     → 顯示未完成清單
 *   /work_done 1              → 標記 #1 完成
 *   /work_del 1               → 刪除 #1
 *   /work_edit 1 更新週會報告 → 修改 #1 內容
 *   /work_all                 → 顯示全部（含已完成）
 *
 * 需求 Provider：db（SQLite）
 */

import { flex } from '../../src/utils/flex.js';

let db;
const COLOR = '#6366f1'; // 靛紫

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

// 群組顯示誰加的；私訊不顯示
async function resolveAddedBy(ctx) {
  if (!ctx.groupId) return '';
  try {
    const p = await ctx.lineApi.getGroupMemberProfile(ctx.groupId, ctx.userId);
    return p?.displayName || '';
  } catch { return ''; }
}

// ── 位置序號解析（畫面顯示 1,2,3… 連號，不用資料庫 id），依 scope 範圍 ──
function getUndoneWork(scopeId) {
  return db.all(
    `SELECT id, content, done, added_by, created_at FROM work_items
     WHERE scope_id = ? AND done = 0
     ORDER BY id`,
    scopeId
  );
}
function workByIndex(scopeId, n) {
  return getUndoneWork(scopeId)[n - 1] || null;
}

// ── 新增工作事項 ──────────────────────────────────────
function addWork(content, scopeId, userId, addedBy) {
  const text = content.trim();
  db.run(
    `INSERT INTO work_items (scope_id, user_id, content, added_by, done, created_at)
     VALUES (?, ?, ?, ?, 0, datetime('now', '+8 hours'))`,
    scopeId, userId, text, addedBy || ''
  );
  return flex.mini({
    icon: '✓',
    title: '已記錄工作',
    body: addedBy ? `${text}\n— ${addedBy}` : text,
    accent: COLOR,
    actions: [{ label: '查看列表', text: '/work' }],
  });
}

// ── 互動式工作清單（簡約式：右側 ✓ ✕；群組顯示誰加的） ──
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
    const meta = t.added_by || formatDate(t.created_at); // 群組顯示誰加、私訊顯示時間
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', spacing: 'sm',
      paddingTop: 'md', paddingBottom: 'md',
      contents: [
        {
          type: 'box', layout: 'horizontal', flex: 1, spacing: 'sm', alignItems: 'center',
          contents: [
            { type: 'text', text: String(pos), size: 'sm', color: '#94a3b8', flex: 0 },
            { type: 'text', text: t.content, size: 'md', color: '#1e293b', flex: 1, wrap: false },
            { type: 'text', text: meta, size: 'xs', color: '#94a3b8', flex: 0, align: 'end' },
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
    contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body } },
  };
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'work',
  helpText: `💼 工作事項 使用說明

① 新增：/work 準備週會報告
② 看清單：/work（每筆有 ✓完成 / ✕刪除 按鈕）
③ 完成：/work_done 1　或點清單的 ✓
④ 刪除：/work_del 1　或點清單的 ✕
⑤ 修改：/work_edit 1 新內容
⑥ 全部（含已完成）：/work_all

🔸 群組裡是「全群共用一份」清單（誰都能加/完成/刪，顯示是誰加的）
🔸 私訊是你個人的清單
編號是清單位置，刪除後自動連號`,
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
        return addWork(match[1], ctx.scopeId, ctx.userId, await resolveAddedBy(ctx));
      },
    },
    {
      // /work <內容>（空格新增）
      name: 'add-work-bare',
      pattern: /^\/work\s+(.+)$/i,
      describe: '/work <內容> — 新增工作事項',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        return addWork(match[1], ctx.scopeId, ctx.userId, await resolveAddedBy(ctx));
      },
    },
    {
      name: 'list-work',
      command: 'list',
      describe: '/work — 顯示工作事項',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = getUndoneWork(ctx.scopeId);
        if (!items.length) return '📋 沒有進行中的工作事項！\n輸入 /work <內容> 新增';
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
        const item = workByIndex(ctx.scopeId, n);
        if (!item) return `❌ 找不到第 ${n} 筆`;
        db.run(`UPDATE work_items SET done = 1, done_at = datetime('now', '+8 hours') WHERE id = ?`, item.id);
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
        const item = workByIndex(ctx.scopeId, n);
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
        const item = workByIndex(ctx.scopeId, n);
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
          `SELECT content, done, added_by, created_at, done_at FROM work_items
           WHERE scope_id = ?
           ORDER BY done ASC, id DESC
           LIMIT 30`,
          ctx.scopeId
        );
        if (!items.length) return '📋 沒有工作事項記錄';

        const lines = ['💼 工作事項（全部）', ''];
        items.forEach((t, i) => {
          const status = t.done ? '✅' : '⬜';
          const who = t.added_by ? ` @${t.added_by}` : '';
          const doneInfo = t.done && t.done_at ? ` (${formatDate(t.done_at)})` : '';
          lines.push(`${status} ${i + 1}. ${t.content}${who}${doneInfo}`);
        });
        const pending = items.filter(t => !t.done).length;
        const completed = items.filter(t => t.done).length;
        lines.push('', `📊 進行中 ${pending} / 已完成 ${completed}`);
        return lines.join('\n');
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    if (!db) { console.warn('[work] no db provider — work storage disabled'); return; }

    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_id TEXT,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        added_by TEXT,
        done INTEGER DEFAULT 0,
        done_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // 既有表升級：補 scope_id / added_by；舊資料 scope_id 回填為 user_id（維持個人）
    const cols = db.all('PRAGMA table_info(work_items)').map(c => c.name);
    if (!cols.includes('scope_id')) db.exec('ALTER TABLE work_items ADD COLUMN scope_id TEXT');
    if (!cols.includes('added_by')) db.exec('ALTER TABLE work_items ADD COLUMN added_by TEXT');
    db.exec('UPDATE work_items SET scope_id = user_id WHERE scope_id IS NULL OR scope_id = ""');
    db.exec('CREATE INDEX IF NOT EXISTS idx_work_scope ON work_items (scope_id, done)');
  },
};
