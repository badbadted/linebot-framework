/**
 * 小帥截行程網頁的某一段回成圖片（2026-10-27）
 *
 * 只截「這個群綁定的行程網頁」（本機 temp-reports clone 的檔案，不吃任何外部網址），
 * 段落只能從固定清單選（這幾天要去哪、D1～D9、住宿交通、實用連結），AI 給不了選擇器。
 * 圖存在 public/shots/<隨機 32 碼>.jpg，經 bot 對外網址給 LINE 抓；3 天後自動刪。
 * 瀏覽器用 Mac 上的 Google Chrome（playwright-core 驅動），閒置 2 分鐘就關。
 */

import { chromium } from 'playwright-core';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const SHOT_DIR = join(ROOT, 'public', 'shots');
const PUBLIC_BASE = (process.env.BOT_PUBLIC_URL || 'https://bot.pushbike-training.app').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEEP_MS = 3 * 24 * 3600_000;
const IDLE_MS = 2 * 60_000;
const MAX_CSS_HEIGHT = 3000; // 太長的段落截上面這段就好（LINE 圖片太長會很難看）

/** 能截的段落（key → 選擇器、給人看的名稱） */
export function sectionOf(key) {
  const k = String(key || '').trim().toLowerCase();
  const d = /^d([1-9])$/.exec(k);
  if (d) return { sel: `#d${d[1]}`, label: `D${d[1]}` };
  if (k === 'glance') return { sel: '.glance', label: '這幾天要去哪' };
  if (k === 'info') return { sel: '.info-section', label: '住宿・交通・資訊' };
  if (k === 'stay') return { sel: 'xpath=//details[summary[contains(., "住宿")]]', label: '住宿資訊' };
  if (k === 'transport') return { sel: 'xpath=//details[summary[contains(., "交通")]]', label: '交通' };
  if (k === 'members') return { sel: 'xpath=//details[summary[contains(., "成員")]]', label: '成員' };
  if (k === 'links') return { sel: '.links-section', label: '實用連結' };
  return null;
}
export const SECTION_KEYS = 'glance（最上面「這幾天要去哪」）、D1～D9（每天的行程）、info（住宿・交通・成員整段）、stay（住宿資訊）、transport（機場交通）、members（成員）、links（實用連結・勸敗清單）';

let browser = null;
let idleTimer = null;
let queue = Promise.resolve();

async function getBrowser() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { browser?.close().catch(() => {}); browser = null; }, IDLE_MS);
  if (!browser?.isConnected()) browser = await chromium.launch({ executablePath: CHROME, headless: true });
  return browser;
}

function cleanup(now = Date.now()) {
  if (!existsSync(SHOT_DIR)) return;
  for (const f of readdirSync(SHOT_DIR)) {
    if (!/^[0-9a-f]{32}(-p)?\.jpg$/.test(f)) continue;
    const p = join(SHOT_DIR, f);
    try { if (now - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p); } catch { /* 刪不掉下次再試 */ }
  }
}

/**
 * 截圖
 * @param htmlPath 本機行程網頁檔案
 * @param key 段落 key（sectionOf）
 * @returns {Promise<{ok:true, url:string, label:string} | {ok:false, error:string}>}
 */
export function capture(htmlPath, key) {
  const sec = sectionOf(key);
  if (!sec) return Promise.resolve({ ok: false, error: '不知道要截哪一段' });
  if (!htmlPath || !existsSync(htmlPath)) return Promise.resolve({ ok: false, error: '找不到行程網頁' });
  // 一次截一張，避免同時開太多分頁
  const job = queue.then(() => doCapture(htmlPath, sec));
  queue = job.catch(() => {});
  return job;
}

async function doCapture(htmlPath, sec) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2 });
    // 只准載入本機檔案與 Google Fonts（行程頁唯一的外部資源），其他一律擋
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('file://') || u.startsWith('https://fonts.googleapis.com/') || u.startsWith('https://fonts.gstatic.com/')) return route.continue();
      return route.abort();
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 15_000 });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    const el = page.locator(sec.sel).first();
    if (!(await el.count())) return { ok: false, error: `網頁上找不到「${sec.label}」` };
    // 收合的區塊（<details>）全部打開再截，不然只會截到標題
    await el.evaluate((n) => { if (n.tagName === 'DETAILS') n.open = true; n.querySelectorAll('details').forEach(d => { d.open = true; }); });
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (!box) return { ok: false, error: `「${sec.label}」沒有顯示出來` };
    mkdirSync(SHOT_DIR, { recursive: true });
    cleanup();
    const name = `${randomBytes(16).toString('hex')}.jpg`;
    const file = join(SHOT_DIR, name);
    const scrollY = await page.evaluate(() => window.scrollY);
    const clip = { x: box.x, y: box.y + scrollY, width: box.width, height: Math.min(box.height, MAX_CSS_HEIGHT) };
    await page.screenshot({ path: file, type: 'jpeg', quality: 80, fullPage: true, clip });
    // LINE 預覽圖上限 1MB：原圖太大就另存一張 1 倍、較低畫質的預覽
    let preview = name;
    if (statSync(file).size > 1_000_000) {
      preview = name.replace('.jpg', '-p.jpg');
      await page.screenshot({ path: join(SHOT_DIR, preview), type: 'jpeg', quality: 55, scale: 'css', fullPage: true, clip });
    }
    return { ok: true, url: `${PUBLIC_BASE}/public/shots/${name}`, previewUrl: `${PUBLIC_BASE}/public/shots/${preview}`, label: sec.label, file, cut: box.height > MAX_CSS_HEIGHT };
  } catch (err) {
    console.warn(`[xiaoshuai-shot] 截圖失敗：${err.message.split('\n')[0]}`);
    return { ok: false, error: '截圖失敗了，等一下再試' };
  } finally {
    await page?.close().catch(() => {});
  }
}

/** LINE 圖片訊息 */
export const imageMessage = (r) => ({ type: 'image', originalContentUrl: r.url, previewImageUrl: r.previewUrl || r.url });
