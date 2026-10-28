/**
 * 網頁預覽（og: meta）共用抓取：妞揪找店、小帥讀連結、小帥收藏連結都用這一份（2026-10-28 從 niujiu/gemini.js 抽出）
 *
 * - 一律走 safeFetch（防 SSRF：不讓 bot 去讀家裡內網）
 * - FB／IG 只對自家預覽爬蟲吐 og: meta，用 facebookexternalhit 的完整 UA
 * - FB 分享短連結轉址後會帶一串參數，帶著參數常只拿到登入牆 → 拿不到預覽時去掉參數再抓一次（只限 FB／IG 本站）
 * - 不帶 cookie、不登入、不用第三方爬蟲：抓不到就是抓不到，交給呼叫端改走上網搜尋或請使用者截圖
 * - 貼文主圖（og:image）只准下載 FB／IG 的 CDN（*.fbcdn.net、*.cdninstagram.com）、https、不跟轉址
 */

import { safeFetch } from './safe-fetch.js';

let defaultFetch = safeFetch;
/** 測試用：換掉抓網頁的函式（null＝換回 safeFetch） */
export function setFetch(f) { defaultFetch = f || safeFetch; }

export const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
export const HINT_MAX = 1200;
const SOCIAL_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch', 'instagram.com', 'www.instagram.com']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const IMAGE_MAX_BYTES = 1_350_000; // 跟看群組照片一樣（Luna 收 2MB 的 JSON，base64 會多 1/3）

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isSocialUrl = (u) => SOCIAL_HOSTS.has(hostOf(u));
/** 這個網址是 Reels／影片還是貼文（給「打不開」那句用） */
export const socialKind = (u) => (/\/(reel|reels|watch|videos?)\b|fb\.watch/i.test(String(u)) ? 'Reels' : '貼文');

const decodeEntities = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

const meta = (html, key) => html.match(new RegExp(`(?:property|name)="${key}"[^>]*content="([^"]*)"`))?.[1]
  || html.match(new RegExp(`content="([^"]*)"[^>]*(?:property|name)="${key}"`))?.[1] || '';

/**
 * 從網頁 HTML 取出預覽：title／desc 原文、hint（og:title＋og:description，重複的去掉）、image（og:image）
 * FB 的 og:title 會放完整貼文說明，og:description 是它的截斷版
 */
export function previewFromHtml(html) {
  const h = String(html || '');
  const title = decodeEntities(meta(h, 'og:title') || h.match(/<title[^>]*>([^<]*)</)?.[1] || '').trim();
  const desc = decodeEntities(meta(h, 'og:description') || meta(h, 'description')).trim();
  const image = decodeEntities(meta(h, 'og:image')).trim();
  if (/^(facebook|instagram|log in|登入)$/i.test(title) && !desc) return { title: '', desc: '', hint: '', image: '' };
  const parts = desc && title.includes(desc.replace(/\.{3}$/, '').slice(0, 40)) ? [title] : [title, desc];
  return { title, desc, hint: parts.filter(Boolean).join(' — ').slice(0, HINT_MAX), image };
}
export const previewHintFromHtml = (html) => previewFromHtml(html).hint;

/** 去掉 FB／IG 網址的分享參數（只留 origin＋path）；不是 FB／IG 或沒參數回 null */
export function stripShareParams(u) {
  try {
    const x = new URL(u);
    return SOCIAL_HOSTS.has(x.hostname.toLowerCase()) && x.search ? `${x.origin}${x.pathname}` : null;
  } catch { return null; }
}

/**
 * 抓預覽：拿不到時（FB／IG 帶參數常只有登入牆）去掉參數再抓一次
 * @param fetch 測試可換掉（預設 safeFetch，見 setFetch）
 * @returns {Promise<{ title, desc, hint, image, finalUrl }>}（抓不到時各欄位是空字串）
 */
export async function fetchPreview(url, { fetch = defaultFetch, timeoutMs = 8000, maxBytes = 1_500_000 } = {}) {
  const get = async (u) => {
    const res = await fetch(u, { headers: { 'User-Agent': PREVIEW_UA }, timeoutMs, maxBytes });
    return { finalUrl: res.finalUrl || u, ...previewFromHtml(res.text) };
  };
  let p = await get(url);
  const bare = !p.hint ? stripShareParams(p.finalUrl) || stripShareParams(url) : null;
  if (bare) {
    try { p = await get(bare); } catch { /* 第二次也抓不到就算了 */ }
  }
  return p;
}

/** 貼文主圖只准 FB／IG 的 CDN：https、*.fbcdn.net、*.cdninstagram.com */
export function socialImageAllowed(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false;
    const h = x.hostname.toLowerCase();
    return h.endsWith('.fbcdn.net') || h.endsWith('.cdninstagram.com');
  } catch { return false; }
}

const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
  : b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : b.slice(0, 4).toString('latin1') === 'GIF8' ? 'image/gif'
      : b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null);

/**
 * 下載貼文主圖給 AI 看：主機白名單、safeFetch、不跟轉址、檢查檔頭與大小；不合格回 null
 * @returns {Promise<{ mediaType, data } | null>}（data 是 base64）
 */
export async function fetchSocialImage(url, { fetch = defaultFetch, maxBytes = IMAGE_MAX_BYTES, timeoutMs = 6000 } = {}) {
  if (!socialImageAllowed(url)) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': PREVIEW_UA }, timeoutMs, maxBytes: maxBytes + 1, maxRedirects: 0 });
    const buf = res.buffer;
    if (!buf?.length || buf.length > maxBytes || (res.status && res.status !== 200)) return null;
    const type = sniff(buf);
    if (!type || !IMAGE_TYPES.has(type)) return null;
    return { mediaType: type, data: buf.toString('base64') };
  } catch (err) {
    console.warn(`[social-preview] 主圖下載失敗：${String(err.message).split('\n')[0]}`);
    return null;
  }
}
