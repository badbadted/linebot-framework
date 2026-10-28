/**
 * 小帥回答時附一張合法授權的圖（2026-10-28）
 *
 * 有人問「長什麼樣子」（景點、建築、物品、一般料理），AI 只在 JSON 給搜尋關鍵字（"photo"），不給網址；
 * 圖一律從 Wikimedia Commons 找，授權由程式判斷（不信 AI）：
 *   - 只收 public domain、CC0、CC BY、CC BY-SA（任何版本）；NC、ND、fair use、非自由、授權欄缺或認不得 → 不貼
 *   - 人物照、商標／logo、卡通角色不貼（關鍵字、檔名、Commons 分類、Restrictions 欄都看）
 *   - 組好署名（📷 作者／授權／Commons 檔案頁）回給呼叫端；小帥目前只寫進 log、不貼到聊天（2026-10-28 使用者定：私人用）
 * 只下載 upload.wikimedia.org 的 https 縮圖（Commons 回的 thumb.wikimedia.org 縮圖換成 upload 同路徑抓），
 * 只收 JPEG／PNG、限大小，存 public/shots（跟行程截圖同一個資料夾、同樣 3 天後刪），用 bot 對外網址給 LINE 抓。
 * Commons 回來的文字（檔名、作者、分類）只當資料：不給 AI 看，只由程式拿來判斷與組署名。
 * 每群每天最多 PER_DAY 張（存 DB，bot 重開不歸零）。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as shot from './shot.js';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'linebot-framework-xiaoshuai/1.0 (https://bot.pushbike-training.app; LINE group bot)';
export const PER_DAY = 10;
const THUMB_WIDTH = 960;      // Commons 標準縮圖寬度之一
const PREVIEW_WIDTH = 500;
const MAX_IMAGE_BYTES = 3_000_000;
const LINE_PREVIEW_MAX = 1_000_000; // LINE 預覽圖上限 1MB
const ARTIST_MAX = 40;
const SEARCH_LIMIT = 15;

let fetchImpl = (...a) => fetch(...a);
let dir = shot.SHOT_DIR;
let db = null;
const memCount = new Map(); // 沒有 DB 時（測試）的備用

/** 測試用：換掉 fetch、存圖資料夾 */
export function configure({ fetch: f, dir: d } = {}) {
  if (f) fetchImpl = f;
  if (d) dir = d;
}

export function initPhotos(database) {
  db = database;
  db?.exec('CREATE TABLE IF NOT EXISTS photo_daily (chat_id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, day))');
}

// ── 授權 ──────────────────────────────────────────

const DENY_RE = /(^|[^a-z])(nc|nd)([^a-z]|$)|non-?commercial|no-?deriv|noderivs|fair[\s_-]*use|non-?free|copyright(ed)?\s+(protected|reserved)|all\s+rights\s+reserved/i;
const PD_RE = /^(public[\s_-]*domain|pd([\s_-].*)?|cc0([\s_-]1\.0)?|cc[\s_-]?zero)$/i;
const CC_RE = /^cc[\s_-]by(?:[\s_-]sa)?(?:[\s_-]\d(?:\.\d)?)?(?:[\s_-][a-z]{2,3})?$/i;

/**
 * 只看 Commons 的 extmetadata 判斷能不能貼。
 * @returns {{ok:true, license:string, kind:'pd'|'cc'} | {ok:false, why:string}}
 */
export function checkLicense(meta) {
  const v = (k) => String(meta?.[k]?.value ?? meta?.[k] ?? '').trim();
  const short = v('LicenseShortName');
  const code = v('License');
  const terms = v('UsageTerms');
  if (!short && !code) return { ok: false, why: '授權欄空白' };
  if (/^true$/i.test(v('NonFree'))) return { ok: false, why: '非自由授權' };
  const all = `${short} ${code} ${terms}`;
  if (DENY_RE.test(all)) return { ok: false, why: `授權有限制：${short || code}` };
  // PD-textlogo、PD-flag 之類：授權本身可以，但內容是標誌，一樣不貼
  if (/logo|trademark|insignia|flag|coat[\s_-]*of[\s_-]*arms|emblem/i.test(all)) return { ok: false, why: `標誌類：${short || code}` };
  // 授權名稱（短名或代碼）要認得出來才收
  const names = [short, code].filter(Boolean);
  if (names.some(n => PD_RE.test(n))) return { ok: true, license: short || code, kind: 'pd' };
  if (names.some(n => CC_RE.test(n))) return { ok: true, license: short || code, kind: 'cc' };
  return { ok: false, why: `認不得的授權：${short || code}` };
}

// ── 主題：人物、商標、卡通 ─────────────────────────

const SUBJECT_RE = new RegExp([
  'logo', 'logos', 'logotype', 'trademark', 'trademarked', 'wordmark', 'emblem', 'insignia', 'brand', 'mascot',
  'cartoon', 'anime', 'manga', 'character', 'characters', 'comic', 'comics', 'cosplay', 'figure', 'figurine', 'pok[eé]mon', 'disney', 'sanrio', 'hello kitty',
  'portrait', 'portraits', 'people', 'person', 'persons', 'selfie', 'men', 'women', 'man', 'woman', 'girl', 'girls', 'boy', 'boys',
  'child', 'children', 'kid', 'kids', 'baby', 'celebrity', 'celebrities', 'actor', 'actress', 'singer', 'idol', 'politician', 'model',
  'footballer', 'players?', 'athletes?', 'crowd', 'wedding', 'face', 'faces', 'living people', 'nude', 'nudity',
].map(w => `\\b${w}\\b`).join('|') + '|ロゴ|商標|キャラクター|アニメ|漫画|人物|肖像|女性|男性|子供|人像|卡通|角色|標誌|商標|動漫|明星|藝人|自拍|網紅', 'i');

/** 關鍵字、檔名、分類、Restrictions 欄有人物／商標／卡通的跡象 → true（寧可錯殺） */
export function blockedSubject({ query = '', title = '', categories = '', restrictions = '' } = {}) {
  if (/personality|trademark|insignia|logo/i.test(restrictions)) return true;
  return [query, title.replace(/_/g, ' '), categories].some(s => SUBJECT_RE.test(String(s || '')));
}

// ── 署名 ──────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Artist 欄是 HTML：去標籤、解實體、壓空白、限長；去完沒字回空字串 */
export function cleanArtist(html, max = ARTIST_MAX) {
  const s = String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? ' ';
    })
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ') // 控制字元、方向覆寫
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

export function attribution(p) {
  const who = p.artist || (p.kind === 'pd' ? '作者不詳' : 'Wikimedia Commons');
  return `📷 ${who}／${p.license}／${p.page}`;
}

// ── 網址 ──────────────────────────────────────────

/** 只准 https 的 upload.wikimedia.org（Commons 檔案路徑）；回傳乾淨網址（去掉查詢字串），不合格回 null */
export function imageUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || x.port) return null;
  // Commons API 給的縮圖網址是 thumb.wikimedia.org，跟 upload.wikimedia.org 同一條路徑：一律換成 upload 抓
  if (x.hostname === 'thumb.wikimedia.org') x.hostname = 'upload.wikimedia.org';
  if (x.hostname !== 'upload.wikimedia.org') return null;
  if (!x.pathname.startsWith('/wikipedia/commons/')) return null;
  x.search = '';
  x.hash = '';
  return x.toString();
}

const pageUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && x.hostname === 'commons.wikimedia.org' && x.pathname.startsWith('/wiki/File:') ? `${x.origin}${x.pathname}` : null;
  } catch { return null; }
};

const imageType = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpg'
  : buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'png' : null);

// ── 每日上限 ──────────────────────────────────────

const today = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
export function usedToday(chatId, now = Date.now()) {
  const day = today(now);
  return db ? (db.get('SELECT n FROM photo_daily WHERE chat_id = ? AND day = ?', chatId, day)?.n || 0) : (memCount.get(`${chatId}|${day}`) || 0);
}
export const canPost = (chatId, now = Date.now()) => usedToday(chatId, now) < PER_DAY;
function countPost(chatId, now = Date.now()) {
  const day = today(now);
  if (!db) { memCount.set(`${chatId}|${day}`, usedToday(chatId, now) + 1); return; }
  db.run('INSERT INTO photo_daily (chat_id, day, n) VALUES (?, ?, 1) ON CONFLICT(chat_id, day) DO UPDATE SET n = n + 1', chatId, day);
  db.run('DELETE FROM photo_daily WHERE day < ?', today(now - 7 * 86400_000));
}

// ── 搜尋與下載 ────────────────────────────────────

async function getJson(url, signal) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'error', signal });
  if (!r.ok) throw new Error(`Commons API ${r.status}`);
  return r.json();
}

async function getImage(url, signal) {
  const u = imageUrl(url);
  if (!u) throw new Error('圖片網址不是 upload.wikimedia.org');
  const r = await fetchImpl(u, { headers: { 'User-Agent': UA }, redirect: 'error', signal });
  if (!r.ok) throw new Error(`下載圖片 ${r.status}`);
  const type = String(r.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') throw new Error(`格式不對：${type || '未知'}`);
  if (Number(r.headers?.get?.('content-length') || 0) > MAX_IMAGE_BYTES) throw new Error('圖片太大');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('圖片太大');
  const ext = imageType(buf);
  if (!ext || (ext === 'jpg') !== (type === 'image/jpeg')) throw new Error('檔案內容不是 JPEG／PNG');
  return { buf, ext };
}

/** 從 Commons 搜尋結果挑第一張合格的（照搜尋排名） */
export function pickCandidate(pages, query) {
  const sorted = [...(pages || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const why = [];
  for (const p of sorted) {
    const ii = p.imageinfo?.[0];
    const meta = ii?.extmetadata || {};
    if (!ii || !['image/jpeg', 'image/png'].includes(ii.mime)) continue;
    const lic = checkLicense(meta);
    if (!lic.ok) { why.push(lic.why); continue; }
    if (blockedSubject({ title: p.title, categories: meta.Categories?.value, restrictions: meta.Restrictions?.value })) { why.push('人物／商標／卡通'); continue; }
    const thumb = imageUrl(ii.thumburl || ii.url);
    const page = pageUrl(ii.descriptionurl);
    if (!thumb || !page) { why.push('網址不合格'); continue; }
    const artist = cleanArtist(meta.Artist?.value);
    if (lic.kind === 'cc' && !artist) { why.push('CC 授權但沒有作者可署名'); continue; }
    return { title: p.title, thumb, page, license: lic.license, kind: lic.kind, artist, query };
  }
  return { none: true, why };
}

/**
 * 找一張圖、下載存好。
 * @returns {Promise<{ok:true, url, previewUrl, credit, page, license} | {ok:false, error}>}
 */
export async function findPhoto(chatId, query, { timeoutMs = 8000, now = Date.now() } = {}) {
  const q = String(query || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  if (!q) return { ok: false, error: '沒有關鍵字' };
  if (blockedSubject({ query: q })) return { ok: false, error: '人物／商標／卡通不找圖' };
  if (!canPost(chatId, now)) return { ok: false, error: '今天的圖片額度用完了' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', origin: '*',
      generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(SEARCH_LIMIT),
      prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: String(THUMB_WIDTH),
      iiextmetadatafilter: 'License|LicenseShortName|Artist|UsageTerms|NonFree|Restrictions|Categories',
    });
    const data = await getJson(`${API}?${params}`, ctrl.signal);
    const c = pickCandidate(data?.query?.pages, q);
    if (c.none) return { ok: false, error: `Commons 找不到能用的圖${c.why.length ? `（${[...new Set(c.why)].slice(0, 3).join('、')}）` : ''}` };
    const img = await getImage(c.thumb, ctrl.signal);
    mkdirSync(dir, { recursive: true });
    shot.cleanup(undefined, dir);
    const base = randomBytes(16).toString('hex');
    const name = `${base}.${img.ext}`;
    writeFileSync(join(dir, name), img.buf);
    let preview = name;
    if (img.buf.length > LINE_PREVIEW_MAX) {
      const small = await getImage(c.thumb.replace(`/${THUMB_WIDTH}px-`, `/${PREVIEW_WIDTH}px-`), ctrl.signal);
      if (small.buf.length > LINE_PREVIEW_MAX) throw new Error('預覽圖太大');
      preview = `${base}-p.${small.ext}`;
      writeFileSync(join(dir, preview), small.buf);
    }
    countPost(chatId, now);
    return {
      ok: true, url: `${shot.PUBLIC_BASE}/public/shots/${name}`, previewUrl: `${shot.PUBLIC_BASE}/public/shots/${preview}`,
      credit: attribution(c), page: c.page, license: c.license, title: c.title,
    };
  } catch (err) {
    console.warn(`[xiaoshuai-photo] 找圖失敗：${String(err.message).split('\n')[0]}`);
    return { ok: false, error: ctrl.signal.aborted ? '找圖逾時' : '找圖失敗' };
  } finally {
    clearTimeout(timer);
  }
}

/** 特定店家：程式組 Google 地圖搜尋連結（不用 AI 給的網址） */
export function mapLink(shop) {
  const s = String(shop || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}` : null;
}
