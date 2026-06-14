/**
 * Swim Plugin — 游泳練習秒數記錄
 *
 * 指令：
 *   /新增游泳選手 綸綸 20180713          → 建立選手（需名稱 + 西元生日 8 碼）
 *   /游泳紀錄 綸綸 自由式 50米45.2秒       → 記錄秒數（須含泳式，可多人多筆；相容 記/紀）
 *   /游泳查詢 綸綸                        → 統計（依泳式×距離分平均/最快）+ 最近 3 日期
 *   /游泳查詢 綸綸 6                      → 該月所有記錄日期
 *   /游泳查詢 綸綸 2026-06-13             → 當天記錄清單（每筆可刪除）
 *   /游泳選手                            → 列出所有選手
 *
 * 泳式：自由式 / 仰式 / 蛙式 / 蝶式
 * 資料共享（不分使用者）：swim_players / swim_records（SQLite）
 * 需求 Provider：db（SQLite）；選用 GEMINI_API_KEY（解析 fallback）
 *
 * 註：尚未設定游泳冠軍標準，故無達標判斷；提供標準後可比照滑步車加上。
 */

import { flex } from '../../src/utils/flex.js';
import { parseRecords, initParseGemini } from '../../src/lib/timing-parse.js';

let db;

const COLOR = '#06b6d4'; // 青色（游泳）

// 泳式
const SWIM_STROKES = [
  { name: '自由式', aliases: ['自由式', '自由'] },
  { name: '仰式', aliases: ['仰式', '仰'] },
  { name: '蛙式', aliases: ['蛙式', '蛙'] },
  { name: '蝶式', aliases: ['蝶式', '蝶'] },
];
const STROKE_ORDER = ['自由式', '仰式', '蛙式', '蝶式'];
function strokeIdx(s) { const i = STROKE_ORDER.indexOf(s); return i < 0 ? 99 : i; }

// ── 時間/日期工具 ──────────────────────────────────────
function nowTW() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function todayTW() {
  const d = nowTW();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mmdd(dateStr) {
  return dateStr.slice(5).replace('-', '/');
}
function fmtBirthday(b) {
  return `${b.slice(0, 4)}/${b.slice(4, 6)}/${b.slice(6, 8)}`;
}
function ageOf(birthday, refDate) {
  const by = +birthday.slice(0, 4), bm = +birthday.slice(4, 6), bd = +birthday.slice(6, 8);
  let ry, rm, rd;
  if (refDate) {
    [ry, rm, rd] = refDate.split('-').map(Number);
  } else {
    const n = nowTW();
    ry = n.getFullYear(); rm = n.getMonth() + 1; rd = n.getDate();
  }
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age--;
  return age;
}
function normalizeDigits(s) {
  return String(s)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}
function isValidBirthday(b) {
  if (!/^\d{8}$/.test(b)) return false;
  const y = +b.slice(0, 4), m = +b.slice(4, 6), d = +b.slice(6, 8);
  const now = nowTW().getFullYear();
  return y >= 1990 && y <= now && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

// ── 資料存取 ──────────────────────────────────────────
function findPlayer(name) {
  return db.get('SELECT * FROM swim_players WHERE name = ?', name);
}

// ── LINE 帳號綁定選手 ──────────────────────────────────
function getBoundPlayers(userId) {
  return db.all(
    `SELECT p.* FROM swim_bindings b JOIN swim_players p ON p.id = b.player_id
     WHERE b.user_id = ? ORDER BY p.name`,
    userId
  );
}
function bindPlayer(userId, playerId) {
  db.run(
    `INSERT OR IGNORE INTO swim_bindings (user_id, player_id, created_at)
     VALUES (?, ?, datetime('now', '+8 hours'))`,
    userId, playerId
  );
}
function unbindPlayer(userId, playerId) {
  db.run('DELETE FROM swim_bindings WHERE user_id = ? AND player_id = ?', userId, playerId);
}
function buildBoundPicker(players) {
  const body = [
    { type: 'text', text: `🏊 我的選手 · ${players.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];
  players.forEach((p, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
      action: { type: 'message', label: '查詢', text: `/游泳查詢 ${p.name}` },
      contents: [
        { type: 'text', text: p.name, size: 'md', color: '#1e293b', flex: 1 },
        { type: 'text', text: `${ageOf(p.birthday)}歲`, size: 'sm', color: '#94a3b8', flex: 0, align: 'end' },
        { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0, align: 'end' },
      ],
    });
  });
  return bubble(body);
}
// 依泳式 × 距離統計
function strokeStats(playerId) {
  const rows = db.all(
    `SELECT stroke, distance, COUNT(*) n, AVG(seconds) avg, MIN(seconds) best
     FROM swim_records WHERE player_id = ?
     GROUP BY stroke, distance`,
    playerId
  );
  rows.sort((a, b) => strokeIdx(a.stroke) - strokeIdx(b.stroke) || a.distance - b.distance);
  return rows;
}
function recentDates(playerId, limit) {
  return db.all(
    `SELECT recorded_date d, COUNT(*) n FROM swim_records WHERE player_id = ?
     GROUP BY recorded_date ORDER BY recorded_date DESC LIMIT ?`,
    playerId, limit
  );
}
function monthDates(playerId, ymPrefix) {
  return db.all(
    `SELECT recorded_date d, COUNT(*) n FROM swim_records
     WHERE player_id = ? AND recorded_date LIKE ?
     GROUP BY recorded_date ORDER BY recorded_date DESC`,
    playerId, `${ymPrefix}-%`
  );
}
function dayRecords(playerId, date) {
  const rows = db.all(
    `SELECT id, stroke, distance, seconds FROM swim_records
     WHERE player_id = ? AND recorded_date = ?`,
    playerId, date
  );
  rows.sort((a, b) => strokeIdx(a.stroke) - strokeIdx(b.stroke) || a.distance - b.distance || a.seconds - b.seconds);
  return rows;
}

function classifyDate(arg) {
  const year = nowTW().getFullYear();
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return { type: 'day', date: arg };
  let m;
  if ((m = arg.match(/^(\d{1,2})[/-](\d{1,2})$/))) {
    const mm = String(+m[1]).padStart(2, '0'), dd = String(+m[2]).padStart(2, '0');
    return { type: 'day', date: `${year}-${mm}-${dd}` };
  }
  if ((m = arg.match(/^(\d{3,4})$/))) {
    const s = m[1].padStart(4, '0');
    return { type: 'day', date: `${year}-${s.slice(0, 2)}-${s.slice(2)}` };
  }
  if ((m = arg.match(/^(\d{1,2})月?$/))) {
    const mm = String(+m[1]).padStart(2, '0');
    return { type: 'month', prefix: `${year}-${mm}`, label: `${+m[1]}月` };
  }
  return null;
}

// ── Flex 建構（簡約式） ──────────────────────────────
function bubble(body) {
  return {
    type: 'flex', altText: '游泳',
    contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body } },
  };
}

function buildSummary(player, stats, dates) {
  const body = [
    { type: 'text', text: `🏊 ${player.name}`, size: 'lg', weight: 'bold', color: '#1e293b' },
    { type: 'text', text: `${ageOf(player.birthday)} 歲 · 生日 ${fmtBirthday(player.birthday)}`, size: 'xs', color: '#94a3b8', margin: 'xs' },
    { type: 'separator', margin: 'lg', color: '#f1f5f9' },
  ];

  if (!stats.length) {
    body.push({ type: 'text', text: '尚無秒數記錄', size: 'sm', color: '#64748b', margin: 'lg' });
    body.push({ type: 'text', text: `用「/游泳紀錄 ${player.name} 自由式 50米45秒」開始記錄`, size: 'xs', color: '#94a3b8', margin: 'sm', wrap: true });
    return bubble(body);
  }

  body.push({ type: 'text', text: '📊 成績統計（依泳式 × 距離）', size: 'sm', color: '#64748b', weight: 'bold', margin: 'lg' });
  let lastStroke = null;
  stats.forEach((s) => {
    if (s.stroke !== lastStroke) {
      lastStroke = s.stroke;
      body.push({ type: 'text', text: s.stroke || '（未分類）', size: 'sm', weight: 'bold', color: COLOR, margin: 'md' });
    }
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', margin: 'sm', spacing: 'sm',
      contents: [
        { type: 'text', text: `${s.distance}米`, size: 'md', weight: 'bold', color: '#1e293b', flex: 0 },
        { type: 'text', text: `平均 ${s.avg.toFixed(2)}　最快 ${s.best.toFixed(2)} 秒`, size: 'sm', color: '#475569', flex: 1, align: 'end', wrap: false },
      ],
    });
    body.push({ type: 'text', text: `${s.n} 筆`, size: 'xxs', color: '#cbd5e1', align: 'end' });
  });

  body.push({ type: 'separator', margin: 'lg', color: '#f1f5f9' });
  body.push({ type: 'text', text: '📅 最近記錄（點日期看當天）', size: 'sm', color: '#64748b', weight: 'bold', margin: 'lg' });
  dates.forEach((d, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push(dateRow(player.name, d));
  });
  return bubble(body);
}

function dateRow(playerName, d) {
  return {
    type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
    action: { type: 'message', label: '查看', text: `/游泳查詢 ${playerName} ${d.d}` },
    contents: [
      { type: 'text', text: mmdd(d.d), size: 'md', color: '#1e293b', flex: 0 },
      { type: 'text', text: `${d.n} 筆`, size: 'sm', color: '#94a3b8', flex: 1, align: 'end' },
      { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0, align: 'end' },
    ],
  };
}

function buildDateList(player, label, dates) {
  const body = [
    { type: 'text', text: `🏊 ${player.name} · ${label}`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];
  if (!dates.length) {
    body.push({ type: 'text', text: '這個範圍沒有記錄', size: 'sm', color: '#64748b', margin: 'md' });
    return bubble(body);
  }
  dates.forEach((d, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push(dateRow(player.name, d));
  });
  return bubble(body);
}

function buildDayList(player, date, records) {
  const ageThen = ageOf(player.birthday, date);
  const body = [
    { type: 'text', text: `🏊 ${player.name} · ${mmdd(date)}（${ageThen}歲）`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];
  if (!records.length) {
    body.push({ type: 'text', text: '這天沒有記錄', size: 'sm', color: '#64748b', margin: 'md' });
    return bubble(body);
  }
  records.forEach((r, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
      contents: [
        {
          type: 'box', layout: 'horizontal', flex: 1, spacing: 'sm', alignItems: 'center',
          contents: [
            { type: 'text', text: `${r.stroke || ''} ${r.distance}米`.trim(), size: 'md', color: '#1e293b', weight: 'bold', flex: 1, wrap: false },
            { type: 'text', text: `${r.seconds.toFixed(2)} 秒`, size: 'md', color: '#475569', flex: 0, align: 'end' },
          ],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '刪除', text: `/游泳刪除 ${r.id}` },
          contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
        },
      ],
    });
  });
  return bubble(body);
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'swim',
  scope: 'all',

  helpText: `🏊 游泳練習 使用說明

① 建立選手（名字＋西元生日8碼）
　/新增游泳選手 綸綸 20180713

② 記錄秒數（要帶泳式，第一個數字＝距離）
　泳式：自由式／仰式／蛙式／蝶式
　/游泳紀錄 綸綸 自由式 50 45.2
　/游泳紀錄 綸綸 自由式 50 45 52　← 兩趟
　/游泳紀錄 綸綸 自由式 50 45、蛙式 50 52　← 換泳式
　/游泳紀錄 綸綸 自由式 50 45、妞妞 蝶式 25 18　← 多人

③ 綁定自己（之後查詢/記錄可省略名字）
　/游泳綁定 綸綸
　/游泳查詢　　← 直接看綸綸
　/游泳紀錄 自由式 50 45　← 直接記到綸綸（泳式仍要帶）

④ 查詢成績
　/游泳查詢 綸綸　　統計（依泳式×距離）
　/游泳查詢 綸綸 6　該月日期
　/游泳查詢 綸綸 0613　當天每筆（可刪）

其他：/游泳選手 列出全部、/游泳解綁 解除綁定`,

  commands: [
    {
      name: 'add-swimmer',
      pattern: /^\/(?:新增游泳選手|游泳新增選手)\s+(.+)$/i,
      describe: '/新增游泳選手 <名稱> <生日YYYYMMDD> — 建立選手',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const raw = normalizeDigits(match[1]).trim();
        const bd = raw.match(/\d{8}/);
        const birthday = bd ? bd[0] : null;
        const name = raw.replace(/\d{8}/, ' ').replace(/\s+/g, ' ').trim();
        if (!name || !birthday) return '需要名稱和生日（西元 8 碼）\n例：/新增游泳選手 綸綸 20180713';
        if (!isValidBirthday(birthday)) return '生日格式錯誤，需西元 8 碼 YYYYMMDD\n例：20180713';
        if (findPlayer(name)) return `選手「${name}」已存在`;
        db.run(
          `INSERT INTO swim_players (name, birthday, created_at)
           VALUES (?, ?, datetime('now', '+8 hours'))`,
          name, birthday
        );
        return flex.mini({
          icon: '🏊', title: '已新增選手', accent: COLOR,
          body: `${name}\n生日 ${fmtBirthday(birthday)}（${ageOf(birthday)} 歲）`,
          actions: [{ label: '查詢成績', text: `/游泳查詢 ${name}` }],
        });
      },
    },
    {
      name: 'add-record',
      pattern: /^\/游泳[紀記]錄\s+(.+)$/i,
      describe: '/游泳紀錄 <名稱> <泳式> <距離>米<秒數>秒 — 記錄秒數',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const input = match[1];
        let records = await parseRecords(input, { categories: SWIM_STROKES });
        // 無名字（如 /游泳紀錄 自由式 50 45）→ 用綁定選手
        if (!records.length && /\d/.test(normalizeDigits(input))) {
          const bound = getBoundPlayers(ctx.userId);
          if (bound.length === 1) {
            records = await parseRecords(`${bound[0].name} ${input}`, { categories: SWIM_STROKES });
          } else if (bound.length > 1) {
            return '你綁定多位選手，請指定名字：\n/游泳紀錄 <名字> <泳式> <距離> <秒數>';
          }
        }
        if (!records.length) {
          return '看不懂格式 🤔\n例：/游泳紀錄 綸綸 自由式 50米45.2秒\n泳式：自由式/仰式/蛙式/蝶式（必填）\n綁定後可省略名字：/游泳紀錄 自由式 50 45';
        }
        const date = todayTW();
        const ok = [];
        const notFound = new Set();
        for (const r of records) {
          const player = findPlayer(r.name);
          if (!player) { notFound.add(r.name); continue; }
          db.run(
            `INSERT INTO swim_records (player_id, stroke, distance, seconds, recorded_date, created_at)
             VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))`,
            player.id, r.category || '', r.distance, r.seconds, date
          );
          ok.push(`${player.name}　${r.category} ${r.distance}米 ${r.seconds.toFixed(2)}秒`);
        }
        const lines = [];
        if (ok.length) lines.push(...ok);
        if (notFound.size) {
          lines.push(`⚠️ 找不到選手：${[...notFound].join('、')}`);
          lines.push('請先 /新增游泳選手 <名稱> <生日>');
        }
        if (!ok.length) return lines.join('\n');
        return flex.mini({
          icon: '⏱️', title: `已記錄 ${ok.length} 筆`, accent: COLOR,
          body: lines.join('\n'),
          actions: notFound.size ? [] : [{ label: '查詢成績', text: `/游泳查詢 ${records[0].name}` }],
        });
      },
    },
    {
      name: 'query',
      pattern: /^\/游泳查詢(?:\s+(.+))?$/i,
      describe: '/游泳查詢 [名稱] [月份/日期] — 查詢成績（綁定後可省略名稱）',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const argStr = (match[1] || '').trim();
        // 不帶名字 → 用綁定選手
        if (!argStr) {
          const bound = getBoundPlayers(ctx.userId);
          if (!bound.length) return '你還沒綁定選手\n用 /游泳綁定 <選手名> 綁定，或 /游泳查詢 <選手名> 直接查';
          if (bound.length === 1) {
            const p = bound[0];
            return buildSummary(p, strokeStats(p.id), recentDates(p.id, 3));
          }
          return buildBoundPicker(bound);
        }
        const args = argStr.split(/\s+/);
        const name = args[0];
        const dateArg = args[1] || '';
        const player = findPlayer(name);
        if (!player) return `找不到選手「${name}」\n用 /新增游泳選手 ${name} <生日> 建立`;

        if (!dateArg) {
          return buildSummary(player, strokeStats(player.id), recentDates(player.id, 3));
        }
        const cls = classifyDate(dateArg);
        if (!cls) return '日期格式看不懂\n月份：/游泳查詢 名字 6\n當天：/游泳查詢 名字 0613';
        if (cls.type === 'month') {
          return buildDateList(player, cls.label, monthDates(player.id, cls.prefix));
        }
        return buildDayList(player, cls.date, dayRecords(player.id, cls.date));
      },
    },
    {
      name: 'bind',
      pattern: /^\/游泳綁定\s+(.+)$/i,
      describe: '/游泳綁定 <選手名> — 綁定選手，之後 /游泳查詢 /游泳紀錄 可省略名稱',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = match[1].trim();
        const player = findPlayer(name);
        if (!player) return `找不到選手「${name}」\n用 /新增游泳選手 ${name} <生日> 建立`;
        bindPlayer(ctx.userId, player.id);
        return flex.mini({
          icon: '🔗', title: '已綁定選手', accent: COLOR,
          body: `${name}\n之後打 /游泳查詢 直接看他、/游泳紀錄 自由式 50 45 直接記`,
          actions: [{ label: '查詢成績', text: `/游泳查詢 ${name}` }],
        });
      },
    },
    {
      name: 'unbind',
      pattern: /^\/游泳解綁(?:\s+(.+))?$/i,
      describe: '/游泳解綁 [選手名] — 解除綁定（不填解除全部）',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const name = (match[1] || '').trim();
        const bound = getBoundPlayers(ctx.userId);
        if (!bound.length) return '你沒有綁定任何選手';
        if (!name) {
          db.run('DELETE FROM swim_bindings WHERE user_id = ?', ctx.userId);
          return `已解除全部綁定（${bound.length} 位）`;
        }
        const player = findPlayer(name);
        if (!player) return `找不到選手「${name}」`;
        unbindPlayer(ctx.userId, player.id);
        return `已解綁：${name}`;
      },
    },
    {
      name: 'my-bindings',
      pattern: /^\/我的游泳綁定$/i,
      describe: '/我的游泳綁定 — 查看綁定的選手',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const bound = getBoundPlayers(ctx.userId);
        if (!bound.length) return '你還沒綁定選手\n用 /游泳綁定 <選手名> 綁定';
        return buildBoundPicker(bound);
      },
    },
    {
      name: 'del-record',
      pattern: /^\/游泳刪除\s+(\d+)$/i,
      describe: '',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const rec = db.get(
          `SELECT r.*, p.name FROM swim_records r
           JOIN swim_players p ON p.id = r.player_id WHERE r.id = ?`,
          id
        );
        if (!rec) return `❌ 找不到該筆記錄`;
        db.run('DELETE FROM swim_records WHERE id = ?', id);
        return `🗑️ 已刪除：${rec.name} ${rec.stroke || ''} ${rec.distance}米 ${rec.seconds.toFixed(2)}秒`;
      },
    },
    {
      name: 'list-swimmers',
      pattern: /^\/游泳選手$/i,
      describe: '/游泳選手 — 列出所有選手',
      type: 'query',
      handler: async (_match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const players = db.all('SELECT name, birthday FROM swim_players ORDER BY name');
        if (!players.length) return '還沒有選手\n用 /新增游泳選手 <名稱> <生日> 建立';
        const body = [
          { type: 'text', text: `🏊 游泳選手 · ${players.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
          { type: 'separator', margin: 'md', color: '#f1f5f9' },
        ];
        players.forEach((p, i) => {
          if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
          body.push({
            type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
            action: { type: 'message', label: '查詢', text: `/游泳查詢 ${p.name}` },
            contents: [
              { type: 'text', text: p.name, size: 'md', color: '#1e293b', flex: 1 },
              { type: 'text', text: `${ageOf(p.birthday)}歲`, size: 'sm', color: '#94a3b8', flex: 0, align: 'end' },
              { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0, align: 'end' },
            ],
          });
        });
        return bubble(body);
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    if (!db) {
      console.warn('[swim] no db provider — swim storage disabled');
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS swim_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        birthday TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS swim_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        stroke TEXT DEFAULT '',
        distance INTEGER NOT NULL,
        seconds REAL NOT NULL,
        recorded_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    // 既有表補 stroke 欄位（升級相容）
    const cols = db.all('PRAGMA table_info(swim_records)').map(c => c.name);
    if (!cols.includes('stroke')) {
      db.exec("ALTER TABLE swim_records ADD COLUMN stroke TEXT DEFAULT ''");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS swim_bindings (
        user_id TEXT NOT NULL,
        player_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, player_id)
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_swim_player_name ON swim_players (name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_swim_rec ON swim_records (player_id, recorded_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_swim_bind_user ON swim_bindings (user_id)');
    initParseGemini();
    console.log('[swim] ready');
  },
};
