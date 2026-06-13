/**
 * Bike Plugin — 滑步車練習秒數記錄
 *
 * 指令：
 *   /新增選手 鈞鈞 20180713        → 建立選手（需名稱 + 西元生日 8 碼）
 *   /紀錄 鈞鈞 10米2.1秒        → 記錄秒數（可多人多筆，規則解析失敗才丟 LLM）
 *   /查詢 鈞鈞                      → 統計（依距離分平均/最快）+ 最近 3 個記錄日期
 *   /查詢 鈞鈞 6                    → 該月所有記錄日期
 *   /查詢 鈞鈞 2026-06-13           → 當天記錄清單（每筆可刪除）
 *   /選手                          → 列出所有選手
 *
 * 資料共享（不分使用者）：bike_players / bike_records（SQLite）
 * 需求 Provider：db（SQLite）；選用 GEMINI_API_KEY（解析 fallback）
 */

import { flex } from '../../src/utils/flex.js';
import { parseRecords, initParseGemini } from './parse.js';

let db;

const COLOR = '#f97316'; // 橘色（滑步車）

// 冠軍標準秒數：年齡 → { 距離: 秒數 }（10/30/50 米）
const CHAMPION = {
  3: { 10: 2.4, 30: 6.0, 50: 9.4 },
  4: { 10: 2.3, 30: 5.8, 50: 9.0 },
  5: { 10: 2.2, 30: 5.4, 50: 8.5 },
  6: { 10: 2.1, 30: 5.0, 50: 8.0 },
  7: { 10: 2.0, 30: 4.8, 50: 7.8 },
  8: { 10: 1.9, 30: 4.6, 50: 7.6 },
};
const CHAMP_DISTANCES = [10, 30, 50];

// 取某年齡某距離的冠軍標準（沒有則 null）
function championTarget(age, distance) {
  return CHAMPION[age]?.[distance] ?? null;
}

// ── 時間/日期工具 ──────────────────────────────────────
function nowTW() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function todayTW() {
  const d = nowTW();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mmdd(dateStr) {
  // '2026-06-13' → '06/13'
  return dateStr.slice(5).replace('-', '/');
}
function fmtBirthday(b) {
  return `${b.slice(0, 4)}/${b.slice(4, 6)}/${b.slice(6, 8)}`;
}
// 年齡：預設算「現在」，給 refDate（YYYY-MM-DD）則算「當天」的年齡
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
// 全形數字/空格 → 半形
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
  return db.get('SELECT * FROM bike_players WHERE name = ?', name);
}
// 依距離統計：最快成績以「當時年齡」對照冠軍標準判斷達標
function distanceStats(player) {
  const recs = db.all(
    'SELECT distance, seconds, recorded_date FROM bike_records WHERE player_id = ? ORDER BY distance, seconds',
    player.id
  );
  const byDist = new Map();
  for (const r of recs) {
    if (!byDist.has(r.distance)) byDist.set(r.distance, []);
    byDist.get(r.distance).push(r);
  }
  const out = [];
  for (const [distance, list] of [...byDist.entries()].sort((a, b) => a[0] - b[0])) {
    const best = list[0]; // 已按 seconds 升序，第一筆即最快
    const sum = list.reduce((acc, r) => acc + r.seconds, 0);
    const ageAtBest = ageOf(player.birthday, best.recorded_date);
    const target = championTarget(ageAtBest, distance);
    out.push({
      distance, n: list.length, avg: sum / list.length,
      best: best.seconds, bestDate: best.recorded_date,
      ageAtBest, target, hit: target != null && best.seconds <= target,
    });
  }
  return out;
}
function recentDates(playerId, limit) {
  return db.all(
    `SELECT recorded_date d, COUNT(*) n FROM bike_records WHERE player_id = ?
     GROUP BY recorded_date ORDER BY recorded_date DESC LIMIT ?`,
    playerId, limit
  );
}
function monthDates(playerId, ymPrefix) {
  return db.all(
    `SELECT recorded_date d, COUNT(*) n FROM bike_records
     WHERE player_id = ? AND recorded_date LIKE ?
     GROUP BY recorded_date ORDER BY recorded_date DESC`,
    playerId, `${ymPrefix}-%`
  );
}
function dayRecords(playerId, date) {
  return db.all(
    `SELECT id, distance, seconds FROM bike_records
     WHERE player_id = ? AND recorded_date = ?
     ORDER BY distance, seconds`,
    playerId, date
  );
}

// 解析查詢的日期參數 → { type:'day', date } | { type:'month', prefix, label } | null
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

// ── Flex 建構（簡約式，與 todo/work 同視覺語言） ──────────
function bubble(body) {
  return {
    type: 'flex', altText: '滑步車',
    contents: { type: 'bubble', size: 'giga', body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body } },
  };
}

function buildSummary(player, stats, dates) {
  const body = [
    { type: 'text', text: `🚲 ${player.name}`, size: 'lg', weight: 'bold', color: '#1e293b' },
    { type: 'text', text: `${ageOf(player.birthday)} 歲 · 生日 ${fmtBirthday(player.birthday)}`, size: 'xs', color: '#94a3b8', margin: 'xs' },
    { type: 'separator', margin: 'lg', color: '#f1f5f9' },
  ];

  if (!stats.length) {
    body.push({ type: 'text', text: '尚無秒數記錄', size: 'sm', color: '#64748b', margin: 'lg' });
    body.push({ type: 'text', text: `用「/紀錄 ${player.name} 10米2.1秒」開始記錄`, size: 'xs', color: '#94a3b8', margin: 'sm', wrap: true });
    return bubble(body);
  }

  body.push({ type: 'text', text: '📊 成績統計（達標以當時年齡判斷）', size: 'sm', color: '#64748b', weight: 'bold', margin: 'lg' });
  stats.forEach((s) => {
    // 達標狀態文字
    let status = '';
    let statusColor = '#94a3b8';
    if (s.target != null) {
      if (s.hit) { status = '✅ 達標'; statusColor = '#16a34a'; }
      else { status = `差 ${(s.best - s.target).toFixed(2)}`; statusColor = COLOR; }
    }
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', margin: 'md', spacing: 'sm',
      contents: [
        { type: 'text', text: `${s.distance}米`, size: 'md', weight: 'bold', color: '#1e293b', flex: 0 },
        { type: 'text', text: `最快 ${s.best.toFixed(2)} 秒`, size: 'sm', color: '#475569', flex: 1, align: 'end', wrap: false },
        ...(status ? [{ type: 'text', text: status, size: 'sm', weight: 'bold', color: statusColor, flex: 0, align: 'end' }] : []),
      ],
    });
    const sub = [`平均 ${s.avg.toFixed(2)}`];
    if (s.target != null) sub.push(`目標 ${s.target.toFixed(2)}（${s.ageAtBest}歲時）`);
    sub.push(`${s.n}筆`);
    body.push({ type: 'text', text: sub.join('　'), size: 'xxs', color: '#cbd5e1', align: 'end' });
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
    action: { type: 'message', label: '查看', text: `/查詢 ${playerName} ${d.d}` },
    contents: [
      { type: 'text', text: mmdd(d.d), size: 'md', color: '#1e293b', flex: 0 },
      { type: 'text', text: `${d.n} 筆`, size: 'sm', color: '#94a3b8', flex: 1, align: 'end' },
      { type: 'text', text: '›', size: 'lg', color: '#cbd5e1', flex: 0, align: 'end' },
    ],
  };
}

function buildDateList(player, label, dates) {
  const body = [
    { type: 'text', text: `🚲 ${player.name} · ${label}`, size: 'sm', color: '#64748b', weight: 'bold' },
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
  const ageThen = ageOf(player.birthday, date); // 當天的年齡
  const body = [
    { type: 'text', text: `🚲 ${player.name} · ${mmdd(date)}（${ageThen}歲）`, size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
  ];
  if (!records.length) {
    body.push({ type: 'text', text: '這天沒有記錄', size: 'sm', color: '#64748b', margin: 'md' });
    return bubble(body);
  }
  records.forEach((r, i) => {
    if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
    const target = championTarget(ageThen, r.distance);
    const hit = target != null && r.seconds <= target;
    body.push({
      type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
      contents: [
        {
          type: 'box', layout: 'horizontal', flex: 1, spacing: 'sm', alignItems: 'center',
          contents: [
            { type: 'text', text: `${r.distance}米`, size: 'md', color: '#1e293b', weight: 'bold', flex: 0 },
            { type: 'text', text: `${r.seconds.toFixed(2)} 秒`, size: 'md', color: '#475569', flex: 1, align: 'end' },
            ...(hit ? [{ type: 'text', text: '✅', size: 'sm', flex: 0, align: 'end' }] : []),
          ],
        },
        {
          type: 'box', layout: 'vertical', width: '30px',
          action: { type: 'message', label: '刪除', text: `/刪秒數 ${r.id}` },
          contents: [{ type: 'text', text: '✕', size: 'lg', align: 'center', color: '#94a3b8' }],
        },
      ],
    });
  });
  return bubble(body);
}

// 冠軍標準表
function buildChampion() {
  const cell = (text, opts = {}) => ({ type: 'text', text, size: opts.size || 'sm', flex: opts.flex ?? 1, align: opts.align || 'end', color: opts.color || '#475569', weight: opts.weight, wrap: false });
  const body = [
    { type: 'text', text: '🏆 冠軍標準（秒）', size: 'sm', color: '#64748b', weight: 'bold' },
    { type: 'separator', margin: 'md', color: '#f1f5f9' },
    {
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md',
      contents: [
        cell('年齡', { flex: 2, align: 'start', color: '#94a3b8', size: 'xs' }),
        ...CHAMP_DISTANCES.map(d => cell(`${d}米`, { color: '#94a3b8', size: 'xs' })),
      ],
    },
    { type: 'separator', margin: 'sm', color: '#f1f5f9' },
  ];
  for (const age of Object.keys(CHAMPION).map(Number)) {
    body.push({
      type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', alignItems: 'center',
      contents: [
        cell(`${age}歲`, { flex: 2, align: 'start', color: '#1e293b', weight: 'bold' }),
        ...CHAMP_DISTANCES.map(d => cell(CHAMPION[age][d].toFixed(1))),
      ],
    });
  }
  return bubble(body);
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'bike',
  scope: 'all',

  commands: [
    // /新增選手 鈞鈞 20180713
    {
      name: 'add-player',
      pattern: /^\/新增選手\s+(.+)$/i,
      describe: '/新增選手 <名稱> <生日YYYYMMDD> — 建立選手',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        // 從整串抓出 8 碼數字當生日，剩下當名字（黏一起或有空格都可）
        const raw = normalizeDigits(match[1]).trim();
        const bd = raw.match(/\d{8}/);
        const birthday = bd ? bd[0] : null;
        const name = raw.replace(/\d{8}/, ' ').replace(/\s+/g, ' ').trim();
        if (!name || !birthday) {
          return '需要名稱和生日（西元 8 碼）\n例：/新增選手 鈞鈞 20180713';
        }
        if (!isValidBirthday(birthday)) {
          return '生日格式錯誤，需西元 8 碼 YYYYMMDD\n例：20180713';
        }
        if (findPlayer(name)) {
          return `選手「${name}」已存在`;
        }
        db.run(
          `INSERT INTO bike_players (name, birthday, created_at)
           VALUES (?, ?, datetime('now', '+8 hours'))`,
          name, birthday
        );
        return flex.mini({
          icon: '🚲', title: '已新增選手', accent: COLOR,
          body: `${name}\n生日 ${fmtBirthday(birthday)}（${ageOf(birthday)} 歲）`,
          actions: [{ label: '查詢成績', text: `/查詢 ${name}` }],
        });
      },
    },
    // /紀錄 鈞鈞 10米2.1秒（可多人多筆）
    {
      name: 'add-record',
      pattern: /^\/紀錄\s+(.+)$/i,
      describe: '/紀錄 <名稱> <距離>米<秒數>秒 — 記錄秒數',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const records = await parseRecords(match[1]);
        if (!records.length) {
          return '看不懂秒數格式 🤔\n例：/紀錄 鈞鈞 10米2.1秒\n（可多筆，用逗號或換行分隔）';
        }
        const date = todayTW();
        const ok = [];
        const notFound = new Set();
        for (const r of records) {
          const player = findPlayer(r.name);
          if (!player) { notFound.add(r.name); continue; }
          db.run(
            `INSERT INTO bike_records (player_id, distance, seconds, recorded_date, created_at)
             VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))`,
            player.id, r.distance, r.seconds, date
          );
          ok.push(`${player.name}　${r.distance}米 ${r.seconds.toFixed(2)}秒`);
        }
        const lines = [];
        if (ok.length) lines.push(...ok);
        if (notFound.size) {
          lines.push(`⚠️ 找不到選手：${[...notFound].join('、')}`);
          lines.push('請先 /新增選手 <名稱> <生日>');
        }
        if (!ok.length) return lines.join('\n');
        return flex.mini({
          icon: '⏱️', title: `已記錄 ${ok.length} 筆`, accent: COLOR,
          body: lines.join('\n'),
          actions: notFound.size ? [] : [{ label: '查詢成績', text: `/查詢 ${records[0].name}` }],
        });
      },
    },
    // /查詢 鈞鈞 [日期/月份]
    {
      name: 'query',
      pattern: /^\/查詢\s+(.+)$/i,
      describe: '/查詢 <名稱> [月份/日期] — 查詢成績與記錄',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const args = match[1].trim().split(/\s+/);
        const name = args[0];
        const dateArg = args[1] || '';
        const player = findPlayer(name);
        if (!player) return `找不到選手「${name}」\n用 /新增選手 ${name} <生日> 建立`;

        if (!dateArg) {
          return buildSummary(player, distanceStats(player), recentDates(player.id, 3));
        }
        const cls = classifyDate(dateArg);
        if (!cls) return '日期格式看不懂\n月份：/查詢 名字 6\n當天：/查詢 名字 0613';
        if (cls.type === 'month') {
          return buildDateList(player, cls.label, monthDates(player.id, cls.prefix));
        }
        return buildDayList(player, cls.date, dayRecords(player.id, cls.date));
      },
    },
    // /刪秒數 <id>（清單 ✕ 按鈕用）
    {
      name: 'del-record',
      pattern: /^\/刪秒數\s+(\d+)$/i,
      describe: '',
      type: 'query',
      handler: async (match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const rec = db.get(
          `SELECT r.*, p.name FROM bike_records r
           JOIN bike_players p ON p.id = r.player_id WHERE r.id = ?`,
          id
        );
        if (!rec) return `❌ 找不到該筆記錄`;
        db.run('DELETE FROM bike_records WHERE id = ?', id);
        return `🗑️ 已刪除：${rec.name} ${rec.distance}米 ${rec.seconds.toFixed(2)}秒`;
      },
    },
    // /選手 — 列出所有選手
    {
      name: 'list-players',
      pattern: /^\/選手$/i,
      describe: '/選手 — 列出所有選手',
      type: 'query',
      handler: async (_match, _ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const players = db.all('SELECT name, birthday FROM bike_players ORDER BY name');
        if (!players.length) return '還沒有選手\n用 /新增選手 <名稱> <生日> 建立';
        const body = [
          { type: 'text', text: `🚲 選手 · ${players.length}`, size: 'sm', color: '#64748b', weight: 'bold' },
          { type: 'separator', margin: 'md', color: '#f1f5f9' },
        ];
        players.forEach((p, i) => {
          if (i > 0) body.push({ type: 'separator', margin: 'md', color: '#f1f5f9' });
          body.push({
            type: 'box', layout: 'horizontal', alignItems: 'center', paddingTop: 'md', paddingBottom: 'md', spacing: 'sm',
            action: { type: 'message', label: '查詢', text: `/查詢 ${p.name}` },
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
    // /冠軍 — 冠軍標準秒數表
    {
      name: 'champion',
      pattern: /^\/冠軍$/i,
      describe: '/冠軍 — 各年齡冠軍標準秒數',
      type: 'query',
      handler: async (_match, _ctx) => buildChampion(),
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    if (!db) {
      console.warn('[bike] no db provider — bike storage disabled');
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS bike_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        birthday TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS bike_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        distance INTEGER NOT NULL,
        seconds REAL NOT NULL,
        recorded_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bike_player_name ON bike_players (name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bike_rec ON bike_records (player_id, recorded_date)');
    initParseGemini();
    console.log('[bike] ready');
  },
};
