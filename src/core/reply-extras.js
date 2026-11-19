/**
 * 回覆附帶（2026-11-19）：把「排著等送」的訊息（例：到期的提醒）併進 bot 下一次的免費回覆，不用推播。
 *
 * 掛法：index.js 建好 lineApi 後呼叫 attachReplyExtras(lineApi)，之後所有人（webhook、各 plugin）
 * 呼叫的 lineApi.reply 都會經過這裡；webhook 每收到一個事件呼叫 lineApi.noteReplyEvent(event)，
 * 記下這個 replyToken 是哪個聊天（群組／聊天室／私訊）的。
 *
 * plugin 用 lineApi.addReplyExtra(name, provider) 登記：
 *   provider.has(scopeId)  → 這個聊天有沒有排著要送的（要快，回覆前會問）
 *   provider.take(scopeId) → { messages: [...], commit(), release() } 或 null
 *     commit：真的送出去了（標記已送）；release：沒送成（留著下次）
 *
 * 規則：
 * - LINE 一次最多 5 則：原本的回覆優先；附帶的放得下就接在後面，放不下就合併成一則文字；
 *   原本已經 5 則，就接在最後一則文字訊息的尾巴；連文字都沒有就留著等下次。
 * - lineApi.reply(token, []) ＝「只送附帶的」：沒有排著的就不送，回 { skipped: true }。
 * - 附帶的害整則被 LINE 拒絕（400）時，改回只送原本的回覆，附帶的留著下次。
 */

const MAX_MESSAGES = 5;
const TEXT_MAX = 5000;
const TOKEN_KEEP_MS = 10 * 60_000; // replyToken 大約一分鐘內有效，留久一點只是保險

function toMessages(payload) {
  if (payload == null) return [];
  if (typeof payload === 'string') return payload ? [{ type: 'text', text: payload }] : [];
  return Array.isArray(payload) ? payload.filter(Boolean) : [payload];
}

/** 一則訊息的純文字版本（合併用） */
function plainOf(m) {
  if (!m) return '';
  if (m.type === 'text') return String(m.text || '');
  if (m.type === 'flex') return String(m.altText || '');
  return '';
}

/** 好幾則附帶訊息合併成一則文字 */
export function mergeToText(messages) {
  const text = messages.map(plainOf).filter(Boolean).join('\n\n');
  return { type: 'text', text: text.slice(0, TEXT_MAX) };
}

/** 依原本的回覆（base）決定附帶的怎麼放；回 { messages, used }，used=false 表示這次放不進去 */
export function combine(base, extra, max = MAX_MESSAGES) {
  if (!extra.length) return { messages: base, used: false };
  const room = max - base.length;
  if (room >= extra.length) return { messages: [...base, ...extra], used: true };
  if (room >= 1) return { messages: [...base, mergeToText(extra)], used: true };
  // 原本已經滿 5 則：接在最後一則文字的尾巴
  const idx = base.map(m => m?.type).lastIndexOf('text');
  if (idx < 0) return { messages: base, used: false };
  const add = mergeToText(extra).text;
  const joined = `${base[idx].text}\n\n${add}`;
  if (joined.length > TEXT_MAX) return { messages: base, used: false };
  const out = base.slice();
  out[idx] = { ...base[idx], text: joined };
  return { messages: out, used: true };
}

export function attachReplyExtras(lineApi, { now = () => Date.now() } = {}) {
  if (lineApi.__replyExtras) return lineApi;
  const origReply = lineApi.reply.bind(lineApi);
  const tokens = new Map();   // replyToken → { scopeId, at }
  const providers = [];       // { name, has, take }

  function prune() {
    const t = now();
    for (const [k, v] of tokens) if (t - v.at > TOKEN_KEEP_MS) tokens.delete(k);
  }

  /** webhook 收到事件時呼叫：記下 replyToken 屬於哪個聊天 */
  function noteReplyEvent(event) {
    const token = event?.replyToken;
    const s = event?.source || {};
    const scopeId = s.groupId || s.roomId || s.userId;
    if (!token || !scopeId) return;
    if (tokens.size > 500) prune();
    tokens.set(token, { scopeId, at: now() });
  }

  function addReplyExtra(name, provider) {
    if (!provider?.has || !provider?.take) throw new Error('provider 要有 has() 與 take()');
    providers.push({ name, has: provider.has, take: provider.take });
  }

  function scopeOfToken(token) { return tokens.get(token)?.scopeId || null; }

  function hasReplyExtras(scopeId) {
    if (!scopeId) return false;
    for (const p of providers) {
      try { if (p.has(scopeId)) return true; } catch (err) { console.error(`[reply-extras] ${p.name}.has: ${err.message}`); }
    }
    return false;
  }

  async function reply(replyToken, payload) {
    const base = toMessages(payload);
    const scopeId = scopeOfToken(replyToken);
    const takes = [];
    if (scopeId && hasReplyExtras(scopeId)) {
      for (const p of providers) {
        try {
          if (!p.has(scopeId)) continue;
          const t = await p.take(scopeId);
          if (t?.messages?.length) takes.push({ ...t, name: p.name });
          else t?.release?.();
        } catch (err) { console.error(`[reply-extras] ${p.name}.take: ${err.message}`); }
      }
    }
    const extra = takes.flatMap(t => t.messages);
    const { messages, used } = combine(base, extra);
    const release = () => { for (const t of takes) { try { t.release?.(); } catch { /* ignore */ } } };
    if (!used) release();
    if (!messages.length) return { skipped: true };

    let res;
    try {
      res = await origReply(replyToken, messages);
    } catch (err) {
      if (!used) throw err;
      release();
      // 附帶的害整則送不出去（格式錯）：只送原本的回覆，附帶的留著下次
      if (base.length && /\b400\b/.test(err.message)) {
        console.warn(`[reply-extras] 附帶訊息被 LINE 拒絕，改只送原本的回覆：${err.message.slice(0, 200)}`);
        return origReply(replyToken, base);
      }
      throw err;
    }
    tokens.delete(replyToken);
    if (used) {
      for (const t of takes) {
        try { t.commit?.(); } catch (err) { console.error(`[reply-extras] ${t.name}.commit: ${err.message}`); }
      }
      console.log(`[reply-extras] ${String(scopeId).slice(0, 8)}... 回覆附帶 ${takes.map(t => `${t.name}×${t.messages.length}`).join('、')}${base.length ? '' : '（只送附帶的）'}`);
    }
    return res;
  }

  // 閒置回覆的主人：某個 plugin 自己會拿這個聊天沒人要的回覆貼東西（例：小帥的 held_answers，
  // 含每天 7:00 後的今日行程），附帶的就跟著它的回覆一起送，別的 plugin 不要搶同一個 replyToken
  const idleOwners = []; // { name, owns(scopeId) }
  function addIdleOwner(name, owns) { idleOwners.push({ name, owns }); }
  function idleOwnedElsewhere(scopeId, except) {
    return idleOwners.some(o => {
      if (o.name === except) return false;
      try { return !!o.owns(scopeId); } catch { return false; }
    });
  }

  lineApi.reply = reply;
  lineApi.addIdleOwner = addIdleOwner;
  lineApi.idleOwnedElsewhere = idleOwnedElsewhere;
  lineApi.noteReplyEvent = noteReplyEvent;
  lineApi.addReplyExtra = addReplyExtra;
  lineApi.hasReplyExtras = hasReplyExtras;
  lineApi.replyScopeOf = scopeOfToken;
  lineApi.__replyExtras = true;
  return lineApi;
}
