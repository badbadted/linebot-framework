/**
 * SOP Plugin — 部門群組查公司文件（skill:rag 開發規範、skill:km 公司 KM）
 *
 * 指令：
 *   /sop <問題>          → 群組裡問（4～200 字）
 *   /sop                 → 使用說明
 *   /sop紀錄 [天數]      →（管理者、私訊）最近的提問紀錄，預設 1 天
 *   /sop回答 <編號>      →（管理者、私訊）某題實際送出的回答原文（抽查模型有沒有亂寫）
 *   /sop統計             →（管理者、私訊）每人題數、找不到比例、估算費用、知識庫版本
 *
 * 能用的條件（兩道都要過）：群組 /開通 sop（groups.json）＋ config/sop.json 的 allowedGroupIds 有列；
 * 私訊不能問（私訊不受 groups.json 限制，家人私訊本來能用任何 plugin）。
 *
 * 資料：
 *   data/kb/sop-kb.db  知識庫（唯讀，只含公司文件，由 bin/sop-kb-sync.mjs 從 Windows 同步過來）
 *   data/sop.db        提問紀錄 sop_qa_log（框架給的 plugin 專屬 db）
 *
 * 模型只走 llm.generate（無工具、無記憶）；回覆自己送 reply，不經框架的「reply 失敗改 push」，
 * 避免吃每月推播額度。
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRetriever } from './retriever.js';
import { embedText } from './embed.js';
import { answer, NOT_FOUND_TEXT } from './answer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = resolve(ROOT, 'config/sop.json');
const KB_PATH = resolve(ROOT, 'data/kb/sop-kb.db');

const DEFAULTS = {
  enabled: true,
  allowedGroupIds: [],
  perUserDaily: 20,
  perGroupDaily: 60,
  cooldownSec: 15,
  minCosine: 0.62,
  topK: 6,
  perDoc: 3,
  model: 'haiku',
  maxTokens: 1500,
};
// 估算費用用（Haiku 5.5 每百萬 token：輸入 $0.10、輸出 $0.50；中文約 1 字 ≈ 1 token）
const PRICE = { haiku: [0.10, 0.50], sonnet: [2, 10] };

const OFFLINE_TEXT = '知識庫暫時無法查詢，請稍後再試。';

export const HELP_TEXT = `文件問答 使用說明

在群組輸入：
/sop 你的問題
例：/sop SQL 要怎麼防注入
例：/sop 請假要走什麼流程

・只根據公司文件（開發規範、KM 文件）回答，附出處與版次
・找不到就會說找不到，內容以原檔為準
・每人每天 20 題，提問會留紀錄供管理者查看`;

let state = {
  db: null,
  llm: null,
  lineApi: null,
  isAdmin: () => false,
  config: { ...DEFAULTS },
  retriever: null,
  checkedFor: null,   // 已通過探針自檢的知識庫 exported_at
  checkError: '',
  cooldown: new Map(), // userId → 上次提問時間
  names: new Map(),    // userId → 顯示名稱
  now: () => Date.now(),
};

export function loadConfig(path = CONFIG_PATH) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function log(row) {
  if (!state.db) return;
  try {
    state.db.run(
      `INSERT INTO sop_qa_log (created_at, user_id, display_name, group_id, question, hit_ids, top_cosine, result, input_chars, output_chars, duration_ms, error)
       VALUES (datetime('now','+8 hours'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.userId, row.displayName || '', row.groupId || '', row.question || '', row.hitIds || '', row.topCosine ?? null,
      row.result, row.inputChars || 0, row.outputChars || 0, row.durationMs || 0, row.error || ''
    );
  } catch (err) {
    console.error(`[sop] log failed: ${err.message}`);
  }
}

// pending：已佔額度、還在查（檢查額度與佔位之間沒有 await，同一個 process 內不會被插隊）
const COUNTED = `('pending','answered','not_found','error')`;

/** 佔一個名額，回傳紀錄 id；之後用 finish() 補上結果 */
function reserve(row) {
  const res = state.db.run(
    `INSERT INTO sop_qa_log (created_at, user_id, display_name, group_id, question, result)
     VALUES (datetime('now','+8 hours'), ?, '', ?, ?, 'pending')`,
    row.userId, row.groupId || '', row.question || ''
  );
  return res.lastInsertRowid;
}
function finish(id, row) {
  try {
    state.db.run(
      `UPDATE sop_qa_log SET display_name = ?, hit_ids = ?, top_cosine = ?, result = ?, input_chars = ?, output_chars = ?, duration_ms = ?, error = ?,
         answer_text = ?
       WHERE id = ?`,
      row.displayName || '', row.hitIds || '', row.topCosine ?? null, row.result,
      row.inputChars || 0, row.outputChars || 0, row.durationMs || 0, row.error || '', row.answerText || '', id
    );
  } catch (err) {
    console.error(`[sop] log update failed: ${err.message}`);
  }
}

function todayCount(where, param) {
  const row = state.db.get(
    `SELECT COUNT(*) AS n FROM sop_qa_log WHERE ${where} = ? AND result IN ${COUNTED} AND date(created_at) = date('now','+8 hours')`,
    param
  );
  return row?.n || 0;
}

async function displayName(groupId, userId) {
  if (state.names.has(userId)) return state.names.get(userId);
  let name = '';
  try {
    // 最多等 3 秒，別吃掉 reply 的時間
    const p = await Promise.race([
      state.lineApi?.getGroupMemberProfile?.(groupId, userId),
      new Promise(res => setTimeout(() => res(null), 3000)),
    ]);
    name = p?.displayName || '';
  } catch { /* 拿不到就空白 */ }
  state.names.set(userId, name);
  return name;
}

async function sendReply(ctx, text) {
  try {
    await ctx.lineApi.reply(ctx.replyToken, text);
    return true;
  } catch (err) {
    // 不改 push：reply 失敗（多半是逾時）就算了，避免吃推播額度
    console.error(`[sop] reply failed: ${err.message}`);
    return false;
  }
}

/** 知識庫換版後要重跑一次探針自檢 */
async function ensureChecked() {
  const r = state.retriever;
  r.maybeReload();
  if (!r.size) return { ok: false, reason: r.disabledReason || '知識庫是空的' };
  const ver = r.meta.exported_at || '';
  if (state.checkedFor === ver) return { ok: true };
  const res = await r.selfCheck();
  if (res.ok) {
    state.checkedFor = ver;
    state.checkError = '';
  } else {
    state.checkError = res.reason;
  }
  return res;
}

/**
 * 主流程。回傳要回覆的文字，或 null（靜默）。實際送出由呼叫端決定（handler 自己 reply）。
 * @returns {Promise<{ reply: string|null, result: string }>}
 */
export async function handleAsk(question, ctx) {
  const cfg = state.config = loadConfig();
  const groupId = ctx.groupId || ctx.roomId || '';
  const base = { userId: ctx.userId, groupId, question };

  // 入口：不在名單的群組一律靜默（不洩漏有這個功能）
  if (!cfg.enabled || !groupId || !cfg.allowedGroupIds.includes(groupId)) {
    log({ ...base, result: 'gated' });
    return { reply: null, result: 'gated' };
  }

  const q = String(question || '').trim();
  if (!q) return { reply: HELP_TEXT, result: 'help' };
  if (q.length < 4 || q.length > 200) {
    return { reply: '問題請寫 4～200 字。\n例：/sop SQL 要怎麼防注入', result: 'invalid' };
  }

  // 沒有資料庫就無法限額，不提供付費查詢
  if (!state.db) return { reply: OFFLINE_TEXT, result: 'error' };

  const now = state.now();
  const last = state.cooldown.get(ctx.userId) || 0;
  if (now - last < cfg.cooldownSec * 1000) {
    log({ ...base, result: 'limited', error: 'cooldown' });
    return { reply: `請等 ${cfg.cooldownSec} 秒再問下一題。`, result: 'limited' };
  }
  if (todayCount('user_id', ctx.userId) >= cfg.perUserDaily) {
    log({ ...base, result: 'limited', error: 'user-daily' });
    return { reply: `今天已經問了 ${cfg.perUserDaily} 題，明天再來。`, result: 'limited' };
  }
  if (todayCount('group_id', groupId) >= cfg.perGroupDaily) {
    log({ ...base, result: 'limited', error: 'group-daily' });
    return { reply: `群組今天的 ${cfg.perGroupDaily} 題額度用完了，明天再來。`, result: 'limited' };
  }
  state.cooldown.set(ctx.userId, now);
  let slot;
  try {
    slot = reserve(base);
  } catch (err) {
    console.error(`[sop] reserve failed: ${err.message}`);
    return { reply: OFFLINE_TEXT, result: 'error' };
  }

  const t0 = Date.now();
  const name = await displayName(groupId, ctx.userId);
  const row = { ...base, displayName: name };
  try {
    const chk = await ensureChecked();
    if (!chk.ok) throw new Error(`知識庫停用：${chk.reason}`);

    const found = await state.retriever.search(q);
    if (found.status === 'disabled') throw new Error(`知識庫停用：${found.reason}`);
    if (found.status === 'not_found') {
      finish(slot, { ...row, result: 'not_found', topCosine: found.topCosine, durationMs: Date.now() - t0, answerText: NOT_FOUND_TEXT });
      return { reply: NOT_FOUND_TEXT, result: 'not_found' };
    }

    if (!state.llm?.generate) throw new Error('沒有可用的 LLM');
    const ans = await answer({ question: q, hits: found.hits, llm: state.llm, model: cfg.model, maxTokens: cfg.maxTokens });
    finish(slot, {
      ...row,
      result: ans.status,
      hitIds: found.hits.map(h => `${h.id}:${h.cosine.toFixed(3)}`).join(','),
      topCosine: found.topCosine,
      inputChars: ans.inputChars,
      outputChars: ans.outputChars,
      durationMs: Date.now() - t0,
      answerText: ans.text, // 實際送出的回覆，供管理者 /sop回答 抽查
    });
    return { reply: ans.text, result: ans.status };
  } catch (err) {
    console.error(`[sop] ask failed: ${err.message}`);
    finish(slot, { ...row, result: 'error', error: err.message, durationMs: Date.now() - t0, answerText: OFFLINE_TEXT });
    return { reply: OFFLINE_TEXT, result: 'error' };
  }
}

// ── 管理者 ────────────────────────────────────────────
export function buildLogText(days = 1) {
  const rows = state.db.all(
    `SELECT id, created_at, display_name, question, result FROM sop_qa_log
     WHERE result != 'gated' AND created_at >= datetime('now','+8 hours', ?) ORDER BY id DESC LIMIT 50`,
    `-${days} days`
  );
  if (!rows.length) return `最近 ${days} 天沒有提問`;
  const label = { pending: '查詢中', answered: '答', not_found: '找不到', limited: '擋', error: '錯誤', invalid: '格式' };
  return [`最近 ${days} 天提問（最多 50 筆）`, ...rows.map(r =>
    `#${r.id} ${r.created_at.slice(5, 16)} ${r.display_name || '（未知）'}［${label[r.result] || r.result}］${r.question}`),
  '', '看某題的回答：/sop回答 編號'].join('\n');
}

/** 單題完整紀錄：問題、提問人、實際送出的回答、命中段落 */
export function buildAnswerText(id) {
  const r = state.db.get(
    `SELECT id, created_at, display_name, question, result, top_cosine, hit_ids, duration_ms, answer_text
     FROM sop_qa_log WHERE id = ?`,
    id
  );
  if (!r) return `找不到 #${id}`;
  const head = [
    `#${r.id} ${r.created_at} ${r.display_name || '（未知）'}`,
    `問：${r.question}`,
    `結果：${r.result}，最高相似度 ${r.top_cosine != null ? Number(r.top_cosine).toFixed(3) : '-'}，${((r.duration_ms || 0) / 1000).toFixed(1)} 秒`,
    `命中段落：${r.hit_ids || '-'}`,
    '',
  ].join('\n');
  const body = r.answer_text || '（這題沒有存回答原文：2026-11-27 改版前的紀錄或被擋下的提問）';
  // LINE 單則上限 5000 字
  return `${head}${body}`.slice(0, 4900);
}

export function buildStatsText() {
  const cfg = state.config;
  const rows = state.db.all(
    `SELECT display_name, COUNT(*) AS n, SUM(result = 'not_found') AS nf, SUM(input_chars) AS ic, SUM(output_chars) AS oc
     FROM sop_qa_log WHERE result IN ${COUNTED} AND created_at >= datetime('now','+8 hours','-30 days')
     GROUP BY user_id ORDER BY n DESC`
  );
  const [pin, pout] = PRICE[cfg.model] || PRICE.haiku;
  let total = 0, ic = 0, oc = 0, nf = 0;
  const lines = ['文件問答 近 30 天'];
  for (const r of rows) {
    total += r.n; ic += r.ic || 0; oc += r.oc || 0; nf += r.nf || 0;
    lines.push(`${r.display_name || '（未知）'}　${r.n} 題，找不到 ${r.nf || 0}`);
  }
  const usd = (ic * pin + oc * pout) / 1e6;
  lines.push('', `合計 ${total} 題，找不到 ${total ? Math.round((nf / total) * 100) : 0}%`);
  lines.push(`估算費用約 US$${usd.toFixed(2)}（以字數估，實際看 Anthropic Console）`);
  const meta = state.retriever?.meta || {};
  lines.push(`知識庫：${meta.count || 0} 段，匯出於 ${meta.exported_at ? meta.exported_at.slice(0, 16).replace('T', ' ') : '未知'}（UTC）`);
  if (state.checkError) lines.push(`知識庫狀態：${state.checkError}`);
  return lines.join('\n');
}

// ── 測試用 ────────────────────────────────────────────
export function _setStateForTest(patch) {
  state = { ...state, ...patch };
}

// ── Plugin ────────────────────────────────────────────
export default {
  name: 'sop',
  scope: 'group',
  helpText: HELP_TEXT,

  commands: [
    {
      name: 'ask',
      pattern: /^\/sop(?:\s+([\s\S]*))?$/i,
      describe: '/sop <問題> — 查公司文件（開發規範、KM）',
      type: 'query',
      handler: async (match, ctx) => {
        const { reply } = await handleAsk(match[1] || '', ctx);
        if (reply) await sendReply(ctx, reply);
        return null; // 自己送了，框架不用再回
      },
    },
    {
      name: 'log',
      pattern: /^\/sop紀錄(?:\s+(\d{1,2}))?$/i,
      describe: '/sop紀錄 [天數] —（管理者）提問紀錄',
      type: 'query',
      scope: 'private',
      handler: async (match, ctx) => {
        if (!state.isAdmin(ctx.userId) || !state.db) return null;
        return buildLogText(Math.min(Number(match[1] || 1), 30));
      },
    },
    {
      name: 'answer',
      pattern: /^\/sop回答\s*#?(\d{1,7})$/i,
      describe: '/sop回答 <編號> —（管理者）看某題實際送出的回答',
      type: 'query',
      scope: 'private',
      handler: async (match, ctx) => {
        if (!state.isAdmin(ctx.userId) || !state.db) return null;
        return buildAnswerText(Number(match[1]));
      },
    },
    {
      name: 'stats',
      pattern: /^\/sop統計$/i,
      describe: '/sop統計 —（管理者）用量與費用估算',
      type: 'query',
      scope: 'private',
      handler: async (_match, ctx) => {
        if (!state.isAdmin(ctx.userId) || !state.db) return null;
        state.config = loadConfig();
        state.retriever?.maybeReload();
        return buildStatsText();
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    state.db = ctx.db;
    state.llm = ctx.providers?.llm || null;
    state.lineApi = ctx.lineApi;
    state.isAdmin = ctx.isAdmin || (() => false);
    state.config = loadConfig();
    if (state.db) {
      state.db.exec(`
        CREATE TABLE IF NOT EXISTS sop_qa_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          user_id TEXT NOT NULL,
          display_name TEXT,
          group_id TEXT,
          question TEXT,
          hit_ids TEXT,
          top_cosine REAL,
          result TEXT NOT NULL,
          input_chars INTEGER,
          output_chars INTEGER,
          duration_ms INTEGER,
          error TEXT,
          answer_text TEXT
        )
      `);
      // 2026-11-27 加：既有表補回答原文欄
      const cols = state.db.all('PRAGMA table_info(sop_qa_log)').map(c => c.name);
      if (!cols.includes('answer_text')) state.db.exec('ALTER TABLE sop_qa_log ADD COLUMN answer_text TEXT');
      state.db.exec('CREATE INDEX IF NOT EXISTS idx_sop_qa_user ON sop_qa_log (user_id, created_at)');
      state.db.exec('CREATE INDEX IF NOT EXISTS idx_sop_qa_group ON sop_qa_log (group_id, created_at)');
    } else {
      console.warn('[sop] no db provider — 不記紀錄、不限額度');
    }
    const c = state.config;
    state.retriever = createRetriever({ dbPath: KB_PATH, embed: embedText, minCosine: c.minCosine, topK: c.topK, perDoc: c.perDoc });
    const ok = state.retriever.load();
    console.log(ok
      ? `[sop] ready: ${state.retriever.size} 段，允許 ${c.allowedGroupIds.length} 個群組`
      : `[sop] 知識庫未載入：${state.retriever.disabledReason}`);
  },
};
