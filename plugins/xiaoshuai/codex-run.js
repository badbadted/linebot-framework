/**
 * 在隔離環境跑一次 Codex（2026-11-14，小帥畫圖用）
 *
 * Codex 用 Mac mini 上使用者自己登入的 ChatGPT 訂閱（`codex login --device-auth`），這裡不碰登入檔。
 * 隔離方式（2026-11-14 在 Mac 用 `codex sandbox` 實測）：
 *   - 每次建全新空資料夾 ~/codex-jobs/<kind>-<隨機碼>/ 當工作目錄，跑完由呼叫端刪
 *   - 權限設定檔 xsjob（用 -c 帶入，不改 ~/.codex/config.toml）：繼承 :workspace（只准寫工作目錄），
 *     讀取擋掉整個家目錄與 /Volumes（NAS），只開 ~/.codex/generated_images 唯讀（Codex 畫好的圖放那裡，要它自己複製出來）；
 *     指令不能上網（畫圖走 Codex 自己的連線，不經沙盒）
 *   - 子行程只給 PATH、HOME、LANG：bot 的 LINE token 等環境變數一律不傳
 *   - 同時只跑一個；逾時整個行程群組砍掉
 * 呼叫端只給「已經整理好的提示詞」；孩子的原話不能直接進來（見 draw.js）。
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
export const JOBS_DIR = process.env.XIAOSHUAI_CODEX_JOBS || join(HOME, 'codex-jobs');
const CODEX_BIN = process.env.XIAOSHUAI_CODEX_BIN || join(HOME, '.npm-global', 'bin', 'codex');
const CHILD_PATH = `${join(HOME, '.npm-global', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
export const DEFAULT_TIMEOUT_MS = 4 * 60_000;

/** 權限設定檔（TOML inline table）：給 -c 用 */
export const PERMISSIONS = 'permissions={xsjob={extends=":workspace", filesystem={"~"="deny", "/Volumes"="deny", "~/.codex/generated_images"="read"}, network={enabled=false}}}';

/** codex exec 的參數（不含提示詞以外的使用者內容） */
export function codexArgs(dir, prompt) {
  return [
    'exec',
    '--skip-git-repo-check', '--ephemeral', '--json',
    '-C', dir,
    '-c', 'default_permissions="xsjob"',
    '-c', PERMISSIONS,
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '--disable', 'plugins',
    '--', prompt,
  ];
}

/** 子行程環境變數：只有這三個 */
export function childEnv() {
  return { PATH: CHILD_PATH, HOME, LANG: 'en_US.UTF-8' };
}

/**
 * 從 Codex 的輸出判斷失敗原因（給使用者看的話由呼叫端決定）
 * @returns {'quota'|'auth'|'blocked'|'error'}
 */
export function classifyFailure(text) {
  const t = String(text || '').toLowerCase();
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b|credits/.test(t)) return 'quota';
  if (/not logged in|login|unauthori[sz]ed|\b401\b|authentication|sign in|refresh.?token/.test(t)) return 'auth';
  if (/content policy|safety|moderation|policy violation|blocked|refus|not allowed|can't help|cannot help/.test(t)) return 'blocked';
  return 'error';
}

let busy = false;
export const isBusy = () => busy;
let spawnImpl = spawn;
/** 測試用：換掉 spawn */
export function configure({ spawn: s } = {}) { if (s) spawnImpl = s; }

/**
 * 跑一次
 * @returns {Promise<{ok:boolean, dir:string, reason?:string, detail?:string, lastMessage?:string, ms:number}>}
 *   reason：busy｜timeout｜quota｜auth｜blocked｜error
 */
export async function run({ kind = 'job', prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (busy) return { ok: false, reason: 'busy', dir: null, ms: 0 };
  busy = true;
  const t0 = Date.now();
  const dir = join(JOBS_DIR, `${kind}-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(join(dir, 'out'), { recursive: true });
    const r = await runChild(dir, prompt, timeoutMs);
    return { ...r, dir, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err.message, dir, ms: Date.now() - t0 };
  } finally {
    busy = false;
  }
}

/** 跑完清掉工作目錄 */
export function cleanupDir(dir) {
  if (!dir || !dir.startsWith(JOBS_DIR + '/') && !dir.startsWith(JOBS_DIR + '\\')) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 下次再清 */ }
}

function runChild(dir, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(CODEX_BIN, codexArgs(dir, prompt), { cwd: dir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ ok: false, reason: 'error', detail: `啟動 Codex 失敗：${err.message}` });
      return;
    }
    let out = '';
    let errText = '';
    let lastMessage = '';
    const failures = [];
    let buf = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已經結束 */ } }
      finish({ ok: false, reason: 'timeout', detail: `超過 ${Math.round(timeoutMs / 1000)} 秒`, lastMessage });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (out.length < 200_000) out += s;
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'error' || ev.type === 'turn.failed') failures.push(JSON.stringify(ev).slice(0, 500));
        const item = ev.item;
        if (ev.type === 'item.completed' && item?.type === 'agent_message' && item.text) lastMessage = String(item.text).slice(0, 2000);
        if (item?.type === 'error' && item.message) failures.push(String(item.message).slice(0, 500));
      }
    });
    child.stderr.on('data', (d) => { if (errText.length < 20_000) errText += d.toString(); });
    child.on('error', (err) => finish({ ok: false, reason: 'error', detail: `Codex 執行失敗：${err.message}` }));
    child.on('close', (code) => {
      const why = [...failures, errText.slice(-2000)].join('\n');
      if (code === 0 && !failures.length) finish({ ok: true, lastMessage });
      else finish({ ok: false, reason: classifyFailure(why + '\n' + lastMessage), detail: `exit ${code}：${why.slice(0, 800)}`, lastMessage });
    });
  });
}
