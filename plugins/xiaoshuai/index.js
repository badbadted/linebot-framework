/**
 * Xiaoshuai Plugin — 小帥：群組裡像真人一樣聊天的角色
 *
 * /小帥 開｜關      （管理員）這個群開始／停止有小帥
 * /小帥 狀態        開了沒、講話時段、記了幾條
 * /小帥 記憶        列出這群的記憶
 * /小帥 忘記        清掉這群的記憶
 *
 * 什麼時候開口（判斷在 brain.js）：被點名一定回、連續 20 則沒提到就看情況插話、
 * 開口後 5 分鐘內自己判斷要不要接；只在 09:00～22:30，回前隨機等 2～6 秒。
 *
 * AI 走 Luna /api/ext/llm：不帶工具、不讀 Luna 家庭記憶（群組有外人）。
 * 記憶每群各自一份，存本 plugin 的 SQLite。回話一律用 reply（不扣推播額度）。
 * 開關不走 groups.json，指令設 ungated，任何群都打得到 /小帥。
 * 需求 Provider：db（SQLite）＋ llm（luna，需有 generate）
 */

import { createBrain } from './brain.js';

const MEMORY_MAX = 30;      // 每群最多記幾條
const MEMORY_PER_REPLY = 2; // 每次最多新增幾條
const MENTION_RE = /小帥/;

let db, lineApi, llm, isAdmin, brain;
const enabled = new Set();
const nameCache = new Map(); // `${chatId}:${userId}` → displayName

export const PERSONA = `你是「小帥」，在一個 LINE 群組裡跟大家聊天的年輕男生。
個性：愛搞笑、會吐槽接梗、偶爾耍廢，但不刻薄，不拿別人的外表、身分開玩笑。
說話：台灣口語、全中文（不要夾英文單字），像朋友打字，一次 1～2 句、大約 30 字，最多 60 字；不用條列、不用 Markdown；大多數時候不用 emoji，要用最多一個。
你是 AI 角色，不用主動強調；有人認真問你是不是 AI，就老實說。
界線：
- 你只能聊天，沒辦法控制設備、訂東西、設提醒；有人要你做事，請他打 /help 看群組指令，不要假裝做了。
- 不知道的事不要編。不談政治、宗教爭議，不給醫療、法律、投資建議。
- 不講任何人的電話、地址、帳號等個資。
- 不要重複對話裡已經用過的梗。
輸出格式：只輸出一個 JSON 物件，前後不要有其他文字：
{"reply":"要說的話，不說就空字串","remember":["值得長期記住的事，0～2 條，沒有就空陣列"]}
remember：只記「已經定案、之後會用到」的事，就算這次不說話也要記；一條一件事，寫清楚是誰、什麼事。已經在記憶裡的不要重複記。
- 該記（格式範例，不是真的記憶）：「1/18 尾牙訂在信義區火鍋店」「小美不吃牛」「露營決定帶兩頂帳篷」「阿傑週五負責買飲料」
- 不該記：天氣、心情、玩笑、問句（「阿豪在問幾點到機場」）、還沒決定的事、電話地址等個資`;

const SITUATION = {
  mention: '有人在叫你（最近的訊息提到小帥），一定要回話，reply 不可以是空字串。',
  idle: '大家聊了一陣子沒找你。如果你有好梗、或能幫上忙，就自然地插一句；沒什麼好說就 reply 空字串。寧可不說，也不要硬聊。',
  window: '你剛剛有參與聊天，但不要一直搶話。預設 reply 空字串；只有最新那則訊息明顯是在跟你說話、或在問你問題，才回。大家在聊別的、在回應別人、或只是在笑，都不要回。',
};

// ── 資料 ───────────────────────────────────────────

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_mem_chat ON memories(chat_id);
  `);
  for (const r of db.all('SELECT chat_id FROM groups WHERE enabled = 1')) enabled.add(r.chat_id);
}

function setEnabled(chatId, on) {
  db.run(
    `INSERT INTO groups (chat_id, enabled, updated_at) VALUES (?, ?, datetime('now','+8 hours'))
     ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    chatId, on ? 1 : 0,
  );
  if (on) enabled.add(chatId); else { enabled.delete(chatId); brain.reset(chatId); }
}

function listMemories(chatId) {
  return db.all('SELECT id, content FROM memories WHERE chat_id = ? ORDER BY id', chatId);
}

function addMemories(chatId, items) {
  const existing = new Set(listMemories(chatId).map(m => m.content));
  const fresh = items
    .filter(x => typeof x === 'string')
    .map(x => x.trim().slice(0, 100))
    .filter(x => x && !existing.has(x))
    .slice(0, MEMORY_PER_REPLY);
  for (const content of fresh) db.run('INSERT INTO memories (chat_id, content) VALUES (?, ?)', chatId, content);
  const rows = listMemories(chatId);
  for (const r of rows.slice(0, Math.max(0, rows.length - MEMORY_MAX))) {
    db.run('DELETE FROM memories WHERE id = ?', r.id);
  }
  return fresh;
}

// ── AI ─────────────────────────────────────────────

export function buildPrompt({ mode, transcript, memories, nowTs = Date.now() }) {
  const time = new Date(nowTs).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const mem = memories.length ? memories.map(m => `- ${m.content}`).join('\n') : '（還沒有）';
  const chat = transcript.length
    ? transcript.map(t => `${t.self ? '小帥（你）' : (t.name || '某人')}：${t.text.slice(0, 300)}`).join('\n')
    : '（沒有）';
  return `現在時間：${time}\n\n【這個群的記憶】\n${mem}\n\n【最近對話】（越下面越新）\n${chat}\n\n【這次的情況】\n${SITUATION[mode]}`;
}

/** AI 回的文字 → { reply, remember }；壞掉的 JSON 盡量救回來 */
export function parseReply(raw, mode) {
  const s = String(raw || '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      return {
        reply: typeof o.reply === 'string' ? o.reply.trim() : '',
        remember: Array.isArray(o.remember) ? o.remember : [],
      };
    } catch { /* 往下走 */ }
  }
  // 不是 JSON：被點名時直接把文字當回覆，其他情況當作不說話
  return { reply: mode === 'mention' && !s.startsWith('{') ? s.slice(0, 200) : '', remember: [] };
}

async function think(chatId, { mode, replyToken, transcript }) {
  const raw = await llm.generate({
    system: PERSONA,
    messages: [{ role: 'user', content: buildPrompt({ mode, transcript, memories: listMemories(chatId) }) }],
    maxTokens: 1500, // AI 會先思考，400 曾在思考階段就用完、回空字串
  });
  const { reply, remember } = parseReply(raw, mode);
  const saved = remember.length ? addMemories(chatId, remember) : [];
  if (saved.length) console.log(`[xiaoshuai] ${chatId.slice(0, 8)} 記住：${saved.join('｜')}`);
  if (!reply) {
    console.log(`[xiaoshuai] ${chatId.slice(0, 8)} ${mode}：不說話`);
    return { replied: false };
  }
  try {
    await lineApi.reply(replyToken, reply);
  } catch (err) {
    // replyToken 過期就算了，不改用 push（群組推播依人數扣額度）
    console.warn(`[xiaoshuai] reply failed: ${err.message}`);
    return { replied: false };
  }
  console.log(`[xiaoshuai] ${chatId.slice(0, 8)} ${mode}：${reply.slice(0, 60)}`);
  return { replied: true, text: reply };
}

// ── 名字 ───────────────────────────────────────────

async function resolveName(chatId, userId, item) {
  if (!userId) return;
  const key = `${chatId}:${userId}`;
  if (nameCache.has(key)) { item.name = nameCache.get(key); return; }
  try {
    // 群組成員不一定加 bot 好友，getProfile 會 404，要用群組成員端點
    const p = await lineApi.getGroupMemberProfile(chatId, userId);
    const name = p?.displayName || '';
    if (name) { nameCache.set(key, name); item.name = name; }
  } catch { /* 聊天室或查不到：維持「某人」 */ }
}

function isMentioned(text, event) {
  if (MENTION_RE.test(text || '')) return true;
  return !!event?.message?.mention?.mentionees?.some(m => m.isSelf);
}

// ── 指令 ───────────────────────────────────────────

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

async function command(match, ctx) {
  const chatId = ctx.groupId || ctx.roomId;
  if (!chatId) return '小帥只在群組聊天，請在群組裡打 /小帥';
  const action = (match[1] || '狀態').trim();
  const { hours } = brain.config;

  if (action === '開' || action === '關') {
    if (!isAdmin(ctx.userId)) return '⛔ 只有管理員能開關小帥';
    if (action === '開') {
      if (!llm?.generate) return '❌ 小帥的 AI 沒接上（需要 Luna）';
      setEnabled(chatId, true);
      return `😎 小帥來了！叫我「小帥」就會回\n講話時段 ${hhmm(hours.start)}～${hhmm(hours.end)}`;
    }
    setEnabled(chatId, false);
    return '小帥先閃了 👋（記憶還在，/小帥 開 就回來）';
  }

  if (action === '記憶') {
    const rows = listMemories(chatId);
    if (!rows.length) return '小帥在這個群還沒記任何事';
    return [`🧠 小帥在這群記得的事（${rows.length}）`, ...rows.map((r, i) => `${i + 1}. ${r.content}`)].join('\n');
  }

  if (action === '忘記') {
    const n = listMemories(chatId).length;
    db.run('DELETE FROM memories WHERE chat_id = ?', chatId);
    return n ? `🧽 清掉了 ${n} 條，小帥在這群什麼都不記得了` : '本來就沒記任何事';
  }

  // 狀態
  const on = enabled.has(chatId);
  const s = brain.status(chatId);
  const lines = [
    `😎 小帥：${on ? '開著' : '關著'}`,
    `講話時段：${hhmm(hours.start)}～${hhmm(hours.end)}${s.inHours ? '' : '（現在休息中）'}`,
    `記憶：${listMemories(chatId).length} 條`,
  ];
  if (on && s.windowLeftMs > 0) lines.push(`聊天中，還會再接話 ${Math.ceil(s.windowLeftMs / 60_000)} 分鐘`);
  if (!on && isAdmin(ctx.userId)) lines.push('打 /小帥 開 讓小帥進來');
  return lines.join('\n');
}

// ── Plugin ─────────────────────────────────────────

export default {
  name: 'xiaoshuai',
  scope: 'group',
  ungated: true,

  helpText: `😎 小帥 使用說明

在群組裡叫「小帥」，它就會回你；大家聊開了它也會自己接話。
講話時段 09:00～22:30。

/小帥 狀態 — 開了沒、記了幾條
/小帥 記憶 — 看小帥在這群記得什麼
/小帥 忘記 — 清掉這群的記憶
/小帥 開｜關 — （管理員）讓小帥進來／離開`,

  commands: [
    {
      name: 'xiaoshuai',
      pattern: /^\/小帥(?:\s*(開|關|狀態|記憶|忘記))?$/,
      describe: '/小帥 狀態｜記憶｜忘記｜開｜關 — 群組聊天角色',
      type: 'query',
      handler: command,
    },
  ],

  async init(ctx) {
    db = ctx.db;
    lineApi = ctx.lineApi;
    llm = ctx.providers?.llm;
    isAdmin = ctx.isAdmin;
    brain = createBrain({ isEnabled: (id) => enabled.has(id), onFire: think });
    if (!db) { console.warn('[xiaoshuai] 沒有 db provider，小帥停用'); return; }
    initDb();
    if (!llm?.generate) console.warn('[xiaoshuai] llm provider 沒有 generate()，小帥無法講話');
    console.log(`[xiaoshuai] 開著的群組：${enabled.size}`);
  },

  onGroupText({ chatId, userId, text }) {
    if (!brain || !enabled.has(chatId)) return;
    const item = brain.observe(chatId, { userId, text });
    if (item) resolveName(chatId, userId, item);
  },

  async onUnmatched({ chatId, text, replyToken, event }) {
    if (!brain || !chatId || !llm?.generate) return false;
    return brain.handle(chatId, { replyToken, isMention: isMentioned(text, event) });
  },
};
