/**
 * 用 TED 自己的 LINE 帳號發小帥的卡片（2026-11-02，預覽：共用/AI產出/mockup/小帥用自己帳號發卡片預覽.html）
 *
 * LIFF 頁（public/xiaoshuai/liff.html?p=share）選卡片 → 預覽 → liff.shareTargetPicker 讓 TED 自己選群組／好友送出。
 * 送出的是 TED 本人的訊息，不扣小帥的推播額度；主機只組卡片給頁面，不代發。
 * 這裡放不需要資料庫的部分：卡片代號、轉發前的清理（拿掉 postback 等只有小帥能收的按鈕、網址再過一次白名單）、
 * 私訊卡片上的「📤 用我的帳號發」按鈕、貼上的 Flex JSON 解析。
 *
 * shareTargetPicker 的限制（LINE 官方文件 2026-11 查）：一次最多 5 則；按鈕只能是 URI 動作；要登入 LINE 才能用。
 */

import * as cards from './cards.js';

export const MAX_MESSAGES = 5;
export const INTRO_MAX = 300;
export const PASTE_MAX = 12_000; // /x/* body 上限 16KB，留位置給其他欄位
const TEXT_MAX = 2000;
const ALT_MAX = 400;
const MAX_NODES = 400;   // 貼上的 JSON 最多幾個元件
const MAX_DEPTH = 12;

// 卡片代號：cal:week｜cal:next_week｜cal:e<id>｜cal:<from>~<to>｜nj:<活動 ID>｜kb:<小卡 id>
export const KEY_RE = /^(?:cal:(?:week|next_week|e\d{1,9}|\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})|nj:[A-Za-z0-9_-]{6,40}|kb:\d{1,9})$/;
export const keyOk = (k) => typeof k === 'string' && KEY_RE.test(k);

/** LIFF 網址：打開發卡片頁，c= 預選哪張 */
export function shareUrl(liffId, key = '') {
  if (!liffId) return null;
  return `https://liff.line.me/${liffId}?p=share${keyOk(key) ? `&c=${encodeURIComponent(key)}` : ''}`;
}

// ── 轉發前清理 ──────────────────────────────────────

const COMPONENTS = new Set(['box', 'text', 'span', 'image', 'icon', 'button', 'separator', 'filler']);
const MSG_TYPES = new Set(['text', 'flex', 'image']);

/**
 * 不能轉出去的網址：小帥自己的行事曆網頁、/x/ API（可能帶編輯碼 #k= 或行事曆 token）、我們的 LIFF（會打開 TED 的發卡片／編輯頁）
 * 比對前先正規化（解碼、主機去結尾點、合併斜線、不分大小寫），免得 %78、BOT.host.、//、%23k= 這類寫法繞過
 * @param opts { host, liffId }
 */
function blocked(s, { host = '', liffId = '' } = {}) {
  let raw = String(s);
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(raw); if (d === raw) break; raw = d; } catch { break; } }
  if (/#k=|[?&#]t=[0-9a-f]{32}/i.test(raw)) return true;
  let x;
  try { x = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw); } catch { return false; }
  const h = x.hostname.toLowerCase().replace(/\.+$/, '');
  const path = x.pathname.replace(/\/{2,}/g, '/').toLowerCase();
  if (host && h === host.toLowerCase() && /^\/(?:public\/cal|x)(?:\/|$)/.test(path)) return true;
  const id = String(liffId || '').toLowerCase();
  if (id && raw.toLowerCase().includes(id) && /(?:^|\.)line\.me$/.test(h)) return true; // liff.line.me、line.me/R/app、miniapp.line.me 都算
  return false;
}
function uriOk(u, opts = {}) {
  return cards.safeUri(u, (s) => !blocked(s, opts));
}
/** 文字裡的網址：被擋的換成「（連結已拿掉）」 */
function scrubText(t, opts) {
  return String(t).replace(/(?:https?:\/\/|www\.)[^\s<>"'）)]+/gi, (u) => (blocked(u, opts) ? '（連結已拿掉）' : u))
    .replace(/#k=[A-Za-z0-9_-]+/g, '');
}

/** 一個 Flex 元件（遞迴）：拿掉非 URI 動作；按鈕沒了動作就整個拿掉；回 null＝拿掉 */
function cleanNode(n, ctx, depth) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  if (++ctx.nodes > MAX_NODES || depth > MAX_DEPTH) { ctx.tooBig = true; return null; }
  if (!COMPONENTS.has(n.type)) return null;
  const o = { ...n };
  delete o.altUri;
  if (o.action) {
    const uri = o.action?.type === 'uri' ? uriOk(o.action.uri, ctx.opts) : null;
    if (uri) o.action = { type: 'uri', label: cards.clean(o.action.label, 20) || '打開', uri };
    else { ctx.dropped++; if (o.type === 'button') return null; delete o.action; }
  }
  if (o.type === 'image' || o.type === 'icon') {
    o.url = uriOk(o.url, ctx.opts);
    if (!o.url) return null;
  }
  if ((o.type === 'text' || o.type === 'span') && typeof o.text === 'string') o.text = scrubText(o.text.slice(0, TEXT_MAX), ctx.opts);
  if (Array.isArray(o.contents)) {
    o.contents = o.contents.map(c => cleanNode(c, ctx, depth + 1)).filter(Boolean);
    if (o.type === 'box' && !o.contents.length) return null;
  } else if (o.type === 'box') return null;
  return o;
}

function cleanBubble(b, ctx) {
  if (!b || b.type !== 'bubble') return null;
  const o = { type: 'bubble' };
  for (const k of ['size', 'direction', 'styles']) if (b[k] != null) o[k] = b[k];
  for (const part of ['header', 'hero', 'body', 'footer']) {
    if (!b[part]) continue;
    const c = cleanNode(b[part], ctx, 1);
    if (c) o[part] = c;
  }
  if (b.action) {
    const c = cleanNode({ type: 'filler', action: b.action }, ctx, 1);
    if (c?.action) o.action = c.action;
  }
  return o.header || o.hero || o.body || o.footer ? o : null;
}

function cleanMessage(m, ctx) {
  if (!m || typeof m !== 'object' || !MSG_TYPES.has(m.type)) return null;
  if (m.type === 'text') {
    const t = scrubText(String(m.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, TEXT_MAX), ctx.opts).trim();
    return t ? { type: 'text', text: t } : null;
  }
  if (m.type === 'image') {
    const a = uriOk(m.originalContentUrl, ctx.opts);
    const b = uriOk(m.previewImageUrl || m.originalContentUrl, ctx.opts);
    return a && b ? { type: 'image', originalContentUrl: a, previewImageUrl: b } : null;
  }
  const c = m.contents;
  let contents = null;
  if (c?.type === 'bubble') contents = cleanBubble(c, ctx);
  else if (c?.type === 'carousel' && Array.isArray(c.contents)) {
    const list = c.contents.slice(0, 12).map(b => cleanBubble(b, ctx)).filter(Boolean);
    if (list.length) contents = list.length === 1 ? list[0] : { type: 'carousel', contents: list };
  }
  if (!contents) return null;
  const alt = cards.clean(scrubText(String(m.altText || '').replace(/\n/g, ' '), ctx.opts), ALT_MAX) || '小帥的卡片';
  return { type: 'flex', altText: alt, contents };
}

/**
 * 要轉發的訊息 → 只留 shareTargetPicker 收得下的
 * @returns {{ messages, dropped }} 或 {{ error }}
 */
export function sanitize(msgs, opts = {}) {
  const ctx = { nodes: 0, dropped: 0, tooBig: false, opts };
  const list = (Array.isArray(msgs) ? msgs : [msgs]).slice(0, 10).map(m => cleanMessage(m, ctx)).filter(Boolean);
  if (ctx.tooBig) return { error: '卡片太複雜了（元件太多或層數太深）' };
  if (!list.length) return { error: '沒有能轉發的內容（只收文字、圖片、Flex 卡片）' };
  if (list.length > MAX_MESSAGES) return { error: `一次最多 ${MAX_MESSAGES} 則` };
  return { messages: list, dropped: ctx.dropped };
}

/** 貼上的 Flex JSON：一則訊息、訊息陣列、或光一張 bubble／carousel（Flex Message Simulator 複製出來的那種） */
export function parsePasted(text) {
  const s = String(text ?? '').trim();
  if (!s) return { error: '還沒貼內容' };
  if (s.length > PASTE_MAX) return { error: `太長了（最多 ${PASTE_MAX} 字）` };
  let v;
  try { v = JSON.parse(s); } catch { return { error: '不是正確的 JSON' }; }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (Array.isArray(v.messages)) v = v.messages;
    else if (v.type === 'bubble' || v.type === 'carousel') v = { type: 'flex', altText: '小帥的卡片', contents: v };
  }
  return { messages: Array.isArray(v) ? v : [v] };
}

/** 開頭那句：有寫就換掉（或補上）第一則文字；寫空白就拿掉 */
export function withIntro(msgs, intro) {
  if (intro == null) return msgs;
  const t = String(intro).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, INTRO_MAX).trim();
  const rest = msgs[0]?.type === 'text' ? msgs.slice(1) : msgs;
  return t ? [{ type: 'text', text: t }, ...rest].slice(0, MAX_MESSAGES) : rest;
}

// ── 私訊卡片上的「📤 用我的帳號發」 ─────────────────

const shareBtn = (uri) => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '📤 用我的帳號發', uri } });

function bubbleWith(b, uri) {
  const btn = shareBtn(uri);
  const f = b.footer;
  if (!f) return { ...b, footer: { type: 'box', layout: 'vertical', paddingAll: '6px', contents: [btn] } };
  if (f.layout === 'vertical') return { ...b, footer: { ...f, contents: [...f.contents, btn] } };
  return { ...b, footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: f.paddingAll || '10px', contents: [{ ...f, paddingAll: '0px' }, btn] } };
}

/** 每張 Flex 卡的底部加按鈕（多張的 carousel 每張都加，滑到哪張都按得到）；不是 Flex 的不動 */
export function addShareButton(msgs, uri) {
  if (!uri) return msgs;
  return msgs.map((m) => {
    if (m?.type !== 'flex') return m;
    const c = m.contents;
    if (c?.type === 'bubble') return { ...m, contents: bubbleWith(c, uri) };
    if (c?.type === 'carousel') return { ...m, contents: { ...c, contents: c.contents.map(b => bubbleWith(b, uri)) } };
    return m;
  });
}
