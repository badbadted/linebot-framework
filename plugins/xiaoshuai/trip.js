/**
 * 小帥改行程網頁：呼叫行程網頁 repo（temp-reports）的 tools/trip.mjs，改完 commit＋push 到 GitHub Pages
 *
 * repo 在 Mac mini 上的 clone（預設 ~/apps/temp-reports，可用 TRIP_REPO_DIR 覆寫），push 走本機 SSH 金鑰。
 * 所有寫入都排隊一個一個做；套用前先 pull，push 失敗會 rebase 後重試一次。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const run = promisify(execFile);
export const TRIP_REPO = process.env.TRIP_REPO_DIR || join(homedir(), 'apps', 'temp-reports');
export const TRIP_BASE_URL = 'https://badbadted.github.io/temp-reports/';
const PULL_EVERY_MS = 5 * 60_000; // 看行程前最多 5 分鐘拉一次（有人從電腦改過網頁也看得到）

export const tripUrl = (name) => `${TRIP_BASE_URL}${name}.html`;
export const validName = (name) => /^[a-z0-9-]{1,60}$/.test(name || '');

let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

const git = (...args) => run('git', args, { cwd: TRIP_REPO, timeout: 30_000 });

async function tool(args, ops) {
  let dir = null;
  try {
    const extra = [];
    if (ops) {
      dir = mkdtempSync(join(tmpdir(), 'trip-ops-'));
      const f = join(dir, 'ops.json');
      writeFileSync(f, JSON.stringify(ops));
      extra.push(f);
    }
    const { stdout } = await run(process.execPath, ['tools/trip.mjs', ...args, ...extra], { cwd: TRIP_REPO, timeout: 20_000 });
    return stdout;
  } catch (err) {
    // describe／apply／check 失敗時 exit code 1，但 stdout 仍是 JSON
    if (err.stdout) return err.stdout;
    throw err;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

let lastPull = 0;
async function freshen() {
  if (Date.now() - lastPull < PULL_EVERY_MS) return;
  lastPull = Date.now();
  try { await git('pull', '-q', '--ff-only'); } catch (err) { console.warn(`[xiaoshuai-trip] pull 失敗：${err.message.split('\n')[0]}`); }
}

/** 本機的行程網頁檔（截圖用，先照常拉最新）；沒有回 null */
export async function pagePath(name) {
  if (!validName(name)) return null;
  await serial(freshen);
  const p = join(TRIP_REPO, `${name}.html`);
  return existsSync(p) ? p : null;
}

/** 給 AI 看的精簡行程（含編號）；讀不到回 null */
export async function outline(name) {
  if (!validName(name)) return null;
  try {
    await serial(freshen);
    return (await tool(['outline', name])).trim() || null;
  } catch (err) {
    console.warn(`[xiaoshuai-trip] outline 失敗：${err.message.split('\n')[0]}`);
    return null;
  }
}

// 第一道格式檢查（trip.mjs 會再完整驗一次並跳脫輸出）：只收已知的修改種類、D1～D9、整數編號、
// 文字欄位不含 < >，避免 AI 產出的東西帶 HTML 進公開網頁
const OPS = new Set(['update_item', 'add_item', 'remove_item', 'set_day', 'set_glance', 'set_more', 'remove_more',
  // 通用版面才有（trip.mjs 會再擋手刻版面）
  'set_meta', 'set_info', 'remove_info', 'add_link', 'remove_link', 'add_day', 'remove_day']);
const NO_DAY = new Set(['set_meta', 'set_info', 'remove_info', 'add_link', 'remove_link', 'add_day']);
const TEXT_KEYS = new Set(['when', 'title', 'text', 'sub', 'date', 'place', 'emoji', 'note', 'dates', 'subtitle', 'hint', 'weekday', 'label']);
const URL_RE = /^https:\/\/[^\s"'<>\\]{1,290}$/;

export function checkOps(ops) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 8) return '修改內容格式不對';
  for (const op of ops) {
    if (!op || typeof op !== 'object' || !OPS.has(op.op)) return '不認得的修改';
    if (!NO_DAY.has(op.op) && !/^D[1-9]$/i.test(String(op.day || ''))) return '日期編號不對';
    if (op.url !== undefined && (typeof op.url !== 'string' || !URL_RE.test(op.url))) return '連結要是 https:// 開頭的網址';
    if (op.color !== undefined && !['fly', 'city', 'ski'].includes(op.color)) return '顏色不對';
    for (const k of ['index', 'after']) {
      if (op[k] !== undefined && op[k] !== null && !Number.isInteger(op[k])) return '項目編號不對';
    }
    if (op.lines !== undefined) {
      if (!Array.isArray(op.lines) || op.lines.length > 12) return '補充資訊格式不對';
      if (op.lines.some(l => typeof l !== 'string' || l.length > 120 || /[<>]/.test(l))) return '文字內容不合法';
    }
    const texts = [op, op.fields, op.item].filter(x => x && typeof x === 'object');
    for (const obj of texts) {
      for (const [k, v] of Object.entries(obj)) {
        if (!TEXT_KEYS.has(k)) continue;
        if (typeof v !== 'string' || v.length > 120 || /[<>]/.test(v)) return '文字內容不合法';
      }
    }
  }
  return null;
}

/** 檢查修改內容，回 { ok, changes, error }（不寫檔） */
export async function describe(name, ops) {
  if (!validName(name)) return { ok: false, error: '行程名稱不合法' };
  const bad = checkOps(ops);
  if (bad) return { ok: false, error: bad };
  try { return JSON.parse(await tool(['describe', name], ops)); }
  catch (err) { return { ok: false, error: err.message.split('\n')[0] }; }
}

/** 套用修改 → commit → push。回 { ok, changes, error } */
export function apply(name, ops, who) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '行程名稱不合法' });
  const bad = checkOps(ops);
  if (bad) return Promise.resolve({ ok: false, error: bad });
  return serial(async () => {
    const files = [`trips/${name}.json`, `${name}.html`];
    let committed = false;
    try {
      // 開始前 repo 要是乾淨的：有人在 Mac 上這份 clone 改了程式或模板，就不讓小帥接著改、也不會一起推上去
      const before = (await git('status', '--porcelain')).stdout.trim();
      if (before) {
        console.error(`[xiaoshuai-trip] repo 有未提交的變動，拒絕更新：\n${before}`);
        return { ok: false, error: 'Mac 上的行程網頁資料夾有其他未提交的改動，先暫停更新，請 TED 看一下' };
      }
      await git('pull', '-q', '--rebase');
      lastPull = Date.now();
      const r = JSON.parse(await tool(['apply', name], ops));
      if (!r.ok) return r;
      // 小帥只能動行程資料：除了這兩個檔，repo 裡任何檔案（程式、模板、其他網頁）有變動就整次取消
      const { stdout } = await git('status', '--porcelain');
      const touched = stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim());
      const outside = touched.filter(f => !files.includes(f));
      if (outside.length) {
        console.error(`[xiaoshuai-trip] 有資料檔以外的變動，取消：${outside.join(', ')}`);
        await git('checkout', '--', ...files);
        return { ok: false, error: '偵測到資料以外的檔案有變動，已取消，請 TED 看一下' };
      }
      await git('add', ...files);
      const msg = `行程：${r.changes.join('；').slice(0, 200)}\n\n${who || '群組成員'} 在 LINE 群組確認，由小帥更新`;
      await git('commit', '-q', '-m', msg);
      committed = true;
      try {
        await git('push', '-q');
      } catch {
        await git('pull', '-q', '--rebase');
        await git('push', '-q');
      }
      return r;
    } catch (err) {
      console.error(`[xiaoshuai-trip] apply 失敗：${err.message}`);
      // 還沒 commit 就失敗：把這次寫到一半的兩個檔還原，下次 pull 才不會卡住（只動 bot 自己這份 clone）
      if (!committed) {
        try { await git('checkout', '--', ...files); } catch { /* 檔案沒被動過 */ }
      }
      return { ok: false, error: committed ? '已改好但推上網站失敗，請 TED 看一下 bot 紀錄' : '寫入網頁失敗，請 TED 看一下 bot 紀錄' };
    }
  });
}

/**
 * 開新行程（通用版面）→ commit → push。只准動 trips/<name>.json、<name>.html、index.html。
 * 回 { ok, url, error }
 */
export function create(name, title, who) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '名稱只能用小寫英文、數字和 -，例如 snow-trip-2028' });
  const t = String(title || '').trim();
  if (!t || t.length > 40 || /[<>]/.test(t)) return Promise.resolve({ ok: false, error: '標題要 1～40 字，不能有 < >' });
  return serial(async () => {
    const files = [`trips/${name}.json`, `${name}.html`, 'index.html'];
    let committed = false;
    try {
      const before = (await git('status', '--porcelain')).stdout.trim();
      if (before) return { ok: false, error: 'Mac 上的行程網頁資料夾有其他未提交的改動，先暫停，請 TED 看一下' };
      await git('pull', '-q', '--rebase');
      lastPull = Date.now();
      const { stdout } = await run(process.execPath, ['tools/trip.mjs', 'create', name, t], { cwd: TRIP_REPO, timeout: 20_000 }).catch(e => e);
      const r = JSON.parse(stdout || '{"ok":false,"error":"建立失敗"}');
      if (!r.ok) return r;
      const touched = (await git('status', '--porcelain')).stdout.split('\n').filter(Boolean).map(l => l.slice(3).trim());
      const outside = touched.filter(f => !files.includes(f));
      if (outside.length) {
        console.error(`[xiaoshuai-trip] 開新行程動到其他檔案，取消：${outside.join(', ')}`);
        await cleanupCreate(name);
        return { ok: false, error: '偵測到其他檔案有變動，已取消，請 TED 看一下' };
      }
      await git('add', ...files);
      await git('commit', '-q', '-m', `行程：開新行程「${t}」（${name}）\n\n${who || '管理員'} 在 LINE 群組開的，由小帥建立`);
      committed = true;
      try { await git('push', '-q'); } catch { await git('pull', '-q', '--rebase'); await git('push', '-q'); }
      return { ok: true, url: tripUrl(name) };
    } catch (err) {
      console.error(`[xiaoshuai-trip] 開新行程失敗：${err.message}`);
      if (!committed) await cleanupCreate(name);
      return { ok: false, error: committed ? '已建好但推上網站失敗，請 TED 看一下 bot 紀錄' : '建立失敗，請 TED 看一下 bot 紀錄' };
    }
  });
}

/** 還沒 commit 就失敗：拿掉這次新建的兩個檔、還原首頁（只動 bot 自己這份 clone） */
async function cleanupCreate(name) {
  for (const f of [join(TRIP_REPO, 'trips', `${name}.json`), join(TRIP_REPO, `${name}.html`)]) {
    try { rmSync(f, { force: true }); } catch { /* 沒建成 */ }
  }
  try { await git('checkout', '--', 'index.html'); } catch { /* 沒動到 */ }
}
