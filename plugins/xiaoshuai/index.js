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
const SEARCH_MAX_USES = 2;  // 被叫時每次最多上網搜幾次（每千次約 10 美元）
const MENTION_RE = /小帥/;

let db, lineApi, llm, isAdmin, brain;
const enabled = new Set();
const nameCache = new Map(); // `${chatId}:${userId}` → displayName
const lastItem = new Map();  // chatId → 最近 observe 的那則（onUnmatched 拿來當觸發訊息）

export const PERSONA = `你是「小帥」，在一個 LINE 群組裡跟大家聊天的年輕男生。
個性：愛搞笑、會吐槽接梗、偶爾耍廢，但不刻薄，不拿別人的外表、身分開玩笑。
說話：台灣口語、全中文（不要夾英文單字），像朋友打字，一次 1～2 句、大約 30 字，最多 60 字；不用條列、不用 Markdown；大多數時候不用 emoji，要用最多一個。
你是 AI 角色，不用主動強調；有人認真問你是不是 AI、是什麼模型，就老實說：你是用 Anthropic 的 Claude 做的。
界線：
- 你只能聊天和上網查資料，沒辦法控制設備、訂東西、設提醒；有人要你做事，請他打 /help 看群組指令，不要假裝做了。
- 上網查：問題需要最新或你不確定的資訊（天氣、雪況、營業時間、交通、附近有什麼、新聞）就查，查到的重點用一兩句講，不貼網址、不列長清單；閒聊不用查。
- 位置：對話裡「［分享位置］」是有人主動分享的所在地，可以拿來回答當下的問題（附近吃什麼、怎麼去）；不要寫進 remember，之後也不要主動提起誰在哪裡。
- 先看懂再回：只根據對話裡真的有的內容回話。看不懂對方在說什麼、或不確定要你做什麼，就簡短反問確認（例如「你是說…嗎？」），不要自己猜一個答案。
- 不要編造群組成員的事（誰怎樣、誰的習慣、誰的身體），也不要拿真人當玩笑的主角；可以吐槽，但只吐槽對話裡真的發生的事。
- 被稱讚就大方道謝，不要反問「叫我幹嘛」。
- 有人叫你「記起來」「記一下」：從前後文找出要記的那件事；確定就寫進 remember，reply 說你記了什麼；不確定是哪件就反問。
- 不知道的事不要編。不談政治、宗教爭議，不給醫療、法律、投資建議。
- 不講任何人的電話、地址、帳號等個資。
- 不要重複對話裡已經用過的梗。
輸出格式：只輸出一個 JSON 物件，前後不要有其他文字：
{"reply":"要說的話，不說就空字串","remember":["值得長期記住的事，0～2 條，沒有就空陣列"]}
remember：只記「已經定案、之後會用到」的事，就算這次不說話也要記；一條一件事，寫清楚是誰、什麼事。已經在記憶裡的不要重複記。
- 該記（格式範例，不是真的記憶）：「1/18 尾牙訂在信義區火鍋店」「小美不吃牛」「露營決定帶兩頂帳篷」「阿傑週五負責買飲料」
- 不該記：天氣、心情、玩笑、問句（「阿豪在問幾點到機場」）、還沒決定的事、電話地址等個資`;

const SITUATION = {
  mention: '有人在叫你，一定要回話，reply 不可以是空字串。最重要的是回應【叫你的那句】；前面的對話只是背景，不要跳去回別的話題。',
  idle: '大家聊了一陣子沒找你。如果你有好梗、或能幫上忙，就自然地插一句；沒什麼好說就 reply 空字串。寧可不說，也不要硬聊。',
  window: '你剛剛有參與聊天。先判斷【最新那則訊息】是不是在跟你說話：回應你剛說的話、問你問題、接著你參與的話題講下去並等你回應，都算；在跟別人說話、聊跟你無關的事、或只是在笑，都不算。這次的 JSON 要多一個欄位 "to_me"（true／false）。to_me 是 true 時 reply 可以留空（會另外請你回）。to_me 是 false 時，預設 reply 空字串，不要搶話。',
  followup: '這句是在接你的話（延續你們剛剛聊的），一定要回，reply 不可以是空字串。重點是回應【接你話的那句】，前面的對話只是背景。',
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
    CREATE TABLE IF NOT EXISTS sent (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
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

const SENT_KEEP_DAYS = 7;

/** 記下小帥送出的訊息 ID：有人用 LINE「回覆」這則時，webhook 的 quotedMessageId 會對得上 */
function rememberSent(chatId, res, text) {
  for (const m of res?.sentMessages || []) {
    if (m?.id) db.run('INSERT OR IGNORE INTO sent (message_id, chat_id, text) VALUES (?, ?, ?)', String(m.id), chatId, text.slice(0, 300));
  }
  db.run(`DELETE FROM sent WHERE created_at < datetime('now','+8 hours','-${SENT_KEEP_DAYS} days')`);
}

/** 被回覆的是不是小帥說的話；是就回傳那句話，不是回傳 null */
function quotedSelf(event) {
  const id = event?.message?.quotedMessageId;
  if (!id || !db) return null;
  return db.get('SELECT text FROM sent WHERE message_id = ?', String(id))?.text ?? null;
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

export function buildPrompt({ mode, transcript, memories, trigger = null, allowChimeIn = true, nowTs = Date.now() }) {
  const time = new Date(nowTs).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const mem = memories.length ? memories.map(m => `- ${m.content}`).join('\n') : '（還沒有）';
  const chat = transcript.length
    ? transcript.map(t => `${t.self ? '小帥（你）' : (t.name || '某人')}：${t.text.slice(0, 300)}`).join('\n')
    : '（沒有）';
  const label = mode === 'mention' ? '叫你的那句' : mode === 'followup' ? '接你話的那句' : '最新那則訊息';
  const quoted = trigger?.quoted ? `\n（這句是用「回覆」功能在回你說的：「${trigger.quoted.slice(0, 200)}」，接著那個話題回）` : '';
  const focus = trigger?.text ? `\n\n【${label}】\n${trigger.name || '某人'}：${trigger.text.slice(0, 300)}${quoted}` : '';
  const noChime = mode === 'window' && !allowChimeIn ? '\n（你剛講過話：to_me 是 false 時，reply 一定要是空字串）' : '';
  return `現在時間：${time}\n\n【這個群的記憶】\n${mem}\n\n【最近對話】（越下面越新）\n${chat}${focus}\n\n【這次的情況】\n${SITUATION[mode]}${noChime}`;
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
        toMe: o.to_me === true,
      };
    } catch { /* 往下走 */ }
  }
  // 不是 JSON：被點名時直接把文字當回覆，其他情況當作不說話
  const plain = (mode === 'mention' || mode === 'followup') && !s.startsWith('{') ? s.slice(0, 200) : '';
  return { reply: plain, remember: [], toMe: false };
}

async function ask(chatId, mode, { trigger, transcript, allowChimeIn = true }) {
  const raw = await llm.generate({
    system: PERSONA,
    messages: [{ role: 'user', content: buildPrompt({ mode, transcript, trigger, allowChimeIn, memories: listMemories(chatId) }) }],
    maxTokens: 1500, // AI 會先思考，400 曾在思考階段就用完、回空字串
    // 要真的回人（被叫、接著聊）→ Sonnet 聽懂再回；判斷要不要接、冷場插話 → Haiku 省錢
    // 被叫、接著聊時可以上網查（天氣、營業時間、附近餐廳…），每次最多搜 2 次
    ...(mode === 'mention' || mode === 'followup'
      ? { model: 'sonnet', effort: 'medium', webSearch: { maxUses: SEARCH_MAX_USES }, timeoutMs: 45_000 }
      : {}),
  });
  const parsed = parseReply(raw, mode);
  const saved = parsed.remember.length ? addMemories(chatId, parsed.remember) : [];
  if (saved.length) console.log(`[xiaoshuai] ${chatId.slice(0, 8)} 記住：${saved.join('｜')}`);
  return parsed;
}

async function send(chatId, mode, replyToken, reply) {
  try {
    const res = await lineApi.reply(replyToken, reply);
    try { rememberSent(chatId, res, reply); } catch (err) { console.warn(`[xiaoshuai] 記錄送出訊息失敗：${err.message}`); }
  } catch (err) {
    // replyToken 過期就算了，不改用 push（群組推播依人數扣額度）
    console.warn(`[xiaoshuai] reply failed: ${err.message}`);
    return false;
  }
  console.log(`[xiaoshuai] ${chatId.slice(0, 8)} ${mode}：${reply.slice(0, 60)}`);
  return true;
}

async function think(chatId, { mode, replyToken, trigger, transcript, allowChimeIn }) {
  if (mode === 'window') {
    // 第一段：Haiku 用語意判斷這句是不是在跟小帥說話
    const judged = await ask(chatId, 'window', { trigger, transcript, allowChimeIn });
    if (judged.toMe) {
      // 第二段：是在接小帥的話 → 跟被叫一樣，用 Sonnet 認真回，並重開視窗
      const { reply } = await ask(chatId, 'followup', { trigger, transcript });
      if (!reply) { console.log(`[xiaoshuai] ${chatId.slice(0, 8)} followup：不說話`); return { replied: false }; }
      return (await send(chatId, 'followup', replyToken, reply)) ? { replied: true, text: reply, asMention: true } : { replied: false };
    }
    if (!judged.reply || !allowChimeIn) {
      console.log(`[xiaoshuai] ${chatId.slice(0, 8)} window：不是在跟小帥說話，不說話`);
      return { replied: false };
    }
    return (await send(chatId, 'window', replyToken, judged.reply)) ? { replied: true, text: judged.reply } : { replied: false };
  }

  const { reply } = await ask(chatId, mode, { trigger, transcript });
  if (!reply) {
    console.log(`[xiaoshuai] ${chatId.slice(0, 8)} ${mode}：不說話`);
    return { replied: false };
  }
  return (await send(chatId, mode, replyToken, reply)) ? { replied: true, text: reply } : { replied: false };
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
    lastItem.set(chatId, item);
    if (item) resolveName(chatId, userId, item);
  },

  async onUnmatched({ chatId, text, replyToken, event }) {
    if (!brain || !chatId || !llm?.generate) return false;
    const item = lastItem.get(chatId);
    const trigger = item?.text === text ? item : { text };
    // 用 LINE「回覆」功能回小帥說的話，也算在叫小帥
    const quoted = quotedSelf(event);
    if (quoted) trigger.quoted = quoted;
    return brain.handle(chatId, { replyToken, isMention: !!quoted || isMentioned(text, event), trigger });
  },
};
