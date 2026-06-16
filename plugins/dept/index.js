/**
 * Dept Plugin — 部門非本人瑕疵派工單記錄
 *
 * 同仁登錄非本人瑕疵的派工單，管理者查詢全部、線下判定處理。
 *
 * 指令：
 *   /派工單綁定 Steven                                   → 綁定你的名字（登錄前先做一次）
 *   /派工單 UTS060226002 行政院主計總處 非本人瑕疵 原因   → 登錄一筆（可多行一次多筆）
 *   /我的派工單                                          → 看自己登錄的
 *   /派工單刪除 UTS060226002                              → 刪自己登錄的某筆
 *   /派工單查詢 [名字]                                    → 管理者查全部（依登錄人分組）
 *
 * 權限：查全部限管理者（config/admin.json）；同仁只能看/刪自己的
 * 資料：dept_bindings / dept_tickets（SQLite）
 */

import { flex } from '../../src/utils/flex.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

let db;
const COLOR = '#475569'; // 板岩灰
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── 管理者判定（讀 config/admin.json） ──────────────────
let adminIds = [];
function loadAdmins() {
  try {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'config/admin.json'), 'utf-8'));
    adminIds = Array.isArray(raw.adminUserIds) ? raw.adminUserIds : [];
  } catch { adminIds = []; }
}
const isManager = (uid) => adminIds.includes(uid);

// ── 工具 ──────────────────────────────────────────────
function nowTW() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function normalize(s) {
  return String(s).replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
}

function getName(userId) {
  const row = db.get('SELECT name FROM dept_bindings WHERE user_id = ?', userId);
  return row ? row.name : null;
}

/** 解析一行派工單：<派工單號> <機關> [非本人瑕疵] <原因> */
function parseLine(line) {
  const s = normalize(line).trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  if (parts.length < 2) return null;
  const ticket_no = parts[0];
  const agency = parts[1];
  let reason = parts.slice(2).join(' ').replace(/^非本人瑕疵[\s,，、:：-]*/, '').trim();
  if (!/^[A-Za-z]/.test(ticket_no)) return null; // 派工單號通常 UTS… 開頭
  return { ticket_no, agency, reason };
}

// ── Flex（自己的清單，簡約式可刪） ──────────────────────
function buildOwnList(name, rows) {
  const body = [
    { type: 'text', text: `📋 ${name} 的派工單 · ${rows.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];
  rows.forEach((t, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
      contents: [
        {
          type: 'box', layout: 'vertical', flex: 1, spacing: 'xs',
          contents: [
            { type: 'text', text: `${t.ticket_no}　${t.agency}`, size: 'sm', color: '#1e293b', weight: 'bold', wrap: true },
            ...(t.reason ? [{ type: 'text', text: t.reason, size: 'xs', color: '#94a3b8', wrap: true }] : []),
          ],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '刪除', text: `/派工單刪除 ${t.ticket_no}` },
          contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
        },
      ],
    });
  });
  return {
    type: 'flex', altText: '我的派工單',
    contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body } },
  };
}

// ── Plugin ────────────────────────────────────────────
export default {
  name: 'dept',
  scope: 'all',

  helpText: `📋 部門派工單（非本人瑕疵）使用說明

① 綁定名字（登錄前先做一次）
　/派工單綁定 Steven

② 登錄派工單（一行：派工單號 機關 原因；可多行一次多筆）
　/派工單 UTS060226002 行政院主計總處 非本人瑕疵 接表單流程送件結果寫錯
　多筆：第二行起繼續貼，一次送出

③ 看自己登的（每筆可 ✕ 刪）
　/我的派工單

④ 刪除
　/派工單刪除 UTS060226002

⑤ 查詢（管理者）— 依登錄人分組列全部
　/派工單查詢　　或　/派工單查詢 Steven

⑥ 清除（管理者）— 審完封存，清單歸零
　/派工單清除 Steven　　或　/派工單清除 全部
　（軟清除，資料保留可復原）

只記非本人瑕疵；判定處理由管理者線下做`,

  commands: [
    // /派工單綁定 <名字>
    {
      name: 'bind',
      pattern: /^\/派工單綁定\s+(.+)$/i,
      describe: '/派工單綁定 <名字> — 綁定登錄人',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = match[1].trim();
        db.run(
          `INSERT INTO dept_bindings (user_id, name, created_at) VALUES (?, ?, datetime('now','+8 hours'))
           ON CONFLICT(user_id) DO UPDATE SET name = excluded.name`,
          ctx.userId, name
        );
        return flex.mini({ icon: '🔗', title: '已綁定', accent: COLOR, body: `登錄人：${name}\n之後 /派工單 ... 會記到你名下`, actions: [{ label: '看我的派工單', text: '/我的派工單' }] });
      },
    },
    // /派工單 <派工單號> <機關> [非本人瑕疵] <原因>（可多行多筆）
    {
      name: 'add',
      pattern: /^\/派工單\s+([\s\S]+)$/i,
      describe: '/派工單 <派工單號> <機關> <原因> — 登錄非本人瑕疵派工單',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = getName(ctx.userId);
        if (!name) return '請先綁定你的名字：\n/派工單綁定 <你的名字>';

        const lines = match[1].split(/\n+/).map(l => l.trim()).filter(Boolean);
        const ok = [];
        const bad = [];
        for (const line of lines) {
          const t = parseLine(line);
          if (!t) { bad.push(line); continue; }
          db.run(
            `INSERT INTO dept_tickets (user_id, name, ticket_no, agency, reason, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now','+8 hours'))`,
            ctx.userId, name, t.ticket_no, t.agency, t.reason
          );
          ok.push(`${t.ticket_no} ${t.agency}`);
        }
        if (!ok.length) {
          return '格式看不懂 🤔\n一行一筆：<派工單號> <機關> <原因>\n例：/派工單 UTS060226002 行政院主計總處 非本人瑕疵 接表單流程送件結果寫錯';
        }
        const lines2 = [`登錄人：${name}`, ...ok.map(x => `· ${x}`)];
        if (bad.length) lines2.push(`⚠️ ${bad.length} 行無法解析，已略過`);
        return flex.mini({ icon: '📋', title: `已登錄 ${ok.length} 筆`, accent: COLOR, body: lines2.join('\n'), actions: [{ label: '看我的派工單', text: '/我的派工單' }] });
      },
    },
    // /我的派工單
    {
      name: 'my',
      pattern: /^\/我的派工單$/i,
      describe: '/我的派工單 — 看自己登錄的派工單',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = getName(ctx.userId);
        if (!name) return '請先綁定你的名字：\n/派工單綁定 <你的名字>';
        // 用綁定的名字過濾（含管理者匯入的同名資料）
        const rows = db.all(
          'SELECT ticket_no, agency, reason FROM dept_tickets WHERE name = ? AND cleared = 0 ORDER BY id DESC',
          name
        );
        if (!rows.length) return `${name} 目前沒有待處理派工單\n用 /派工單 <派工單號> <機關> <原因> 登錄`;
        return buildOwnList(name, rows);
      },
    },
    // /派工單刪除 <派工單號>（只能刪自己的）
    {
      name: 'del',
      pattern: /^\/派工單刪除\s+(.+)$/i,
      describe: '/派工單刪除 <派工單號> — 刪除自己登錄的',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = getName(ctx.userId);
        if (!name) return '請先綁定你的名字：\n/派工單綁定 <你的名字>';
        const no = match[1].trim();
        const row = db.get('SELECT id FROM dept_tickets WHERE name = ? AND ticket_no = ? AND cleared = 0', name, no);
        if (!row) return `找不到「${no}」`;
        db.run('DELETE FROM dept_tickets WHERE id = ?', row.id);
        return `🗑️ 已刪除：${no}`;
      },
    },
    // /派工單查詢 [名字] — 管理者查全部
    {
      name: 'query',
      pattern: /^\/派工單查詢(?:\s+(.+))?$/i,
      describe: '/派工單查詢 [名字] —（管理者）依登錄人查全部',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        if (!isManager(ctx.userId)) return '⛔ 僅管理者可查詢全部\n看自己的請用 /我的派工單';

        const filter = (match[1] || '').trim();
        const rows = filter
          ? db.all('SELECT name, ticket_no, agency, reason FROM dept_tickets WHERE name = ? AND cleared = 0 ORDER BY id', filter)
          : db.all('SELECT name, ticket_no, agency, reason FROM dept_tickets WHERE cleared = 0 ORDER BY name, id');
        if (!rows.length) return filter ? `「${filter}」沒有待處理派工單` : '目前沒有待處理派工單';

        // 依登錄人分組
        const groups = new Map();
        for (const r of rows) {
          if (!groups.has(r.name)) groups.set(r.name, []);
          groups.get(r.name).push(r);
        }
        const lines = [`📋 非本人瑕疵派工單（共 ${rows.length} 筆 · ${groups.size} 人）`];
        for (const [name, items] of groups) {
          lines.push('════════════');
          lines.push(`【${name}】${items.length} 筆`);
          for (const t of items) {
            lines.push(`· ${t.ticket_no} ${t.agency}`);
            if (t.reason) lines.push(`　${t.reason}`);
          }
        }
        return lines.join('\n');
      },
    },
    // /派工單清除 <名字|全部> — 管理者審完封存（軟清除，可復原）
    {
      name: 'clear',
      pattern: /^\/派工單清除\s+(.+)$/i,
      describe: '/派工單清除 <名字|全部> —（管理者）審完清空清單',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        if (!isManager(ctx.userId)) return '⛔ 僅管理者可清除';
        const target = match[1].trim();
        const all = /^(全部|all|\*)$/i.test(target);
        const res = all
          ? db.run(`UPDATE dept_tickets SET cleared = 1, cleared_at = datetime('now','+8 hours') WHERE cleared = 0`)
          : db.run(`UPDATE dept_tickets SET cleared = 1, cleared_at = datetime('now','+8 hours') WHERE name = ? AND cleared = 0`, target);
        const n = res.changes || 0;
        if (!n) return all ? '目前沒有待處理派工單' : `「${target}」沒有待處理派工單`;
        return flex.mini({
          icon: '✅', title: `已清除 ${n} 筆`, accent: COLOR,
          body: `${all ? '全部' : target} 的待處理派工單已封存\n（資料保留，需要可復原）`,
        });
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    if (!db) { console.warn('[dept] no db provider — disabled'); return; }
    db.exec(`
      CREATE TABLE IF NOT EXISTS dept_bindings (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS dept_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        ticket_no TEXT NOT NULL,
        agency TEXT,
        reason TEXT,
        cleared INTEGER DEFAULT 0,
        cleared_at TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // 既有表補 cleared 欄（軟清除/封存）
    const cols = db.all('PRAGMA table_info(dept_tickets)').map(c => c.name);
    if (!cols.includes('cleared')) db.exec('ALTER TABLE dept_tickets ADD COLUMN cleared INTEGER DEFAULT 0');
    if (!cols.includes('cleared_at')) db.exec('ALTER TABLE dept_tickets ADD COLUMN cleared_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_dept_tickets_user ON dept_tickets (user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_dept_tickets_name ON dept_tickets (name)');
    loadAdmins();
    console.log('[dept] ready');
  },
};
