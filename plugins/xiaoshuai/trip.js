/**
 * 小帥改行程網頁：呼叫行程網頁 repo（temp-reports）的 tools/trip.mjs，改完 commit＋push 到 GitHub Pages
 *
 * repo 在 Mac mini 上的 clone（預設 ~/apps/temp-reports，可用 TRIP_REPO_DIR 覆寫），push 走本機 SSH 金鑰。
 * 所有寫入都排隊一個一個做；套用前先 pull，push 失敗會 rebase 後重試一次。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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

/** 檢查修改內容，回 { ok, changes, error }（不寫檔） */
export async function describe(name, ops) {
  if (!validName(name)) return { ok: false, error: '行程名稱不合法' };
  try { return JSON.parse(await tool(['describe', name], ops)); }
  catch (err) { return { ok: false, error: err.message.split('\n')[0] }; }
}

/** 套用修改 → commit → push。回 { ok, changes, error } */
export function apply(name, ops, who) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '行程名稱不合法' });
  return serial(async () => {
    const files = [`trips/${name}.json`, `${name}.html`];
    let committed = false;
    try {
      await git('pull', '-q', '--rebase');
      lastPull = Date.now();
      const r = JSON.parse(await tool(['apply', name], ops));
      if (!r.ok) return r;
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
