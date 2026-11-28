/**
 * 用本機 Claude Code CLI（claude -p）當回答引擎，介面跟 Luna provider 的 generate 一樣，
 * 可以直接餵給 plugins/sop/answer.js 的 answer()。
 *
 * 安全設定（實測 2.1.317：init 事件 tools=[]、mcp_servers=[]）：
 *   --tools ""（關掉所有內建工具）、--strict-mcp-config、--safe-mode（不載 CLAUDE.md／skills／hooks／MCP）、
 *   --disable-slash-commands、--no-session-persistence、--permission-prompts none。
 *   問題與文件段落走 stdin，不放命令列；spawn 不經 shell；cwd 是每次新建的空資料夾。
 *   子程序環境拿掉 ANTHROPIC_*、CLAUDECODE、CLAUDE_CODE_*（只刪不讀），確保走使用者自己的 CLI 登入（訂閱）。
 */

import { spawn as nodeSpawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

export const DEFAULT_EXE = process.env.SOP_DESK_CLAUDE || join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');

const STRIP_ENV = /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_)/;

export function buildArgs({ model, system }) {
  return [
    '-p',
    '--model', model,
    '--tools', '',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--output-format', 'json',
    '--system-prompt', system,
  ];
}

export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !STRIP_ENV.test(k)));
}

/** 把 CLI 的錯誤訊息轉成使用者看得懂的話 */
export function explainError(msg) {
  const m = String(msg || '');
  if (/authenticat|log ?in|OAuth|unauthori/i.test(m)) return 'Claude 沒有登入或登入過期：請在 PowerShell 執行 claude auth login';
  if (/rate|limit|quota|usage/i.test(m)) return `Claude 額度或速率限制：${m.slice(0, 120)}`;
  return `Claude 回答失敗：${m.slice(0, 160)}`;
}

/**
 * @param {{ exe?: string, model?: string, timeoutMs?: number, spawn?: Function }} [opts]
 */
export function createClaudeCli({ exe = DEFAULT_EXE, model = 'haiku', timeoutMs = 60000, spawn = nodeSpawn } = {}) {
  async function generate({ system, messages, timeoutMs: t = timeoutMs }) {
    const input = (messages || []).map(m => (typeof m.content === 'string' ? m.content : '')).join('\n\n');
    const cwd = mkdtempSync(join(tmpdir(), 'sop-desk-'));
    try {
      return await new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        let done = false;
        const child = spawn(exe, buildArgs({ model, system }), {
          cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { child.kill(); } catch { /* 已結束 */ }
          reject(Object.assign(new Error(`Claude 回答逾時（${Math.round(t / 1000)} 秒）`), { code: 'TIMEOUT' }));
        }, t);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new Error(e.code === 'ENOENT' ? `找不到 Claude CLI：${exe}` : `Claude CLI 啟動失敗：${e.message}`));
        });
        child.on('close', code => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          let res = null;
          try { res = JSON.parse(out.trim().split('\n').pop()); } catch { /* 不是 JSON */ }
          if (res && res.is_error === false && typeof res.result === 'string') return resolve(res.result);
          reject(new Error(explainError(res?.result || err || `exit ${code}`)));
        });
        child.stdin.on('error', () => { /* 子程序先結束時忽略 */ });
        child.stdin.end(input);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  // 登入狀態：claude auth status 回 JSON（loggedIn），快取 60 秒
  let authCache = { at: 0, value: null };
  async function status() {
    if (!existsSync(exe)) return { available: false, loggedIn: false, reason: `找不到 Claude CLI：${exe}` };
    if (Date.now() - authCache.at < 60_000 && authCache.value) return authCache.value;
    const value = await new Promise(resolve => {
      let out = '';
      const child = spawn(exe, ['auth', 'status'], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } resolve({ available: true, loggedIn: null }); }, 10_000);
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => { clearTimeout(timer); resolve({ available: false, loggedIn: false }); });
      child.on('close', () => {
        clearTimeout(timer);
        try { resolve({ available: true, loggedIn: JSON.parse(out).loggedIn === true }); } catch { resolve({ available: true, loggedIn: null }); }
      });
    });
    authCache = { at: Date.now(), value };
    return value;
  }

  return { generate, status, exe, model, available: () => existsSync(exe) };
}
