/**
 * Gate Plugin — 家用遊戲大廳的對外開關（只限管理員私訊）
 *
 * - /開遊戲 [2小時｜30分]  打開外網，預設 2 小時，最長 6 小時，22:00 一律關
 * - /關遊戲               立刻關閉外網
 * - /遊戲狀態             查看是否開放、幾點關
 * - /延長 [1小時]          延後關門時間（不超過 22:00、開門後 6 小時）
 *
 * 實際開關由 Mac mini 的 ~/apps/web-hub/bin/web-gate.mjs 執行；
 * 自動關閉與通知由 web-hub 的 launchd 每分鐘檢查，不靠這個 plugin。
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = process.env.WEB_GATE_SCRIPT || join(homedir(), 'apps/web-hub/bin/web-gate.mjs');
const LAN_URL = 'http://192.168.0.222:4800/';

function isAdmin(userId) {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'config/admin.json'), 'utf-8'));
    return Array.isArray(raw.adminUserIds) && raw.adminUserIds.includes(userId);
  } catch {
    return false;
  }
}

/** 執行開關腳本，回傳它印出的 JSON */
function gate(...args) {
  return new Promise((ok) => {
    execFile(process.execPath, [GATE, ...args], { timeout: 40_000 }, (err, stdout) => {
      const line = String(stdout || '').trim().split('\n').pop();
      try {
        ok(JSON.parse(line));
      } catch {
        ok({ ok: false, reason: 'exec', message: err ? err.message : '開關沒有回應' });
      }
    });
  });
}

/** 「2小時」「1.5h」「30分」→ 小時數；沒寫就是 undefined（用預設 2 小時） */
function parseHours(num, unit) {
  if (!num) return undefined;
  const n = Number(num);
  return /分/.test(unit || '') ? n / 60 : n;
}

const DURATION = '(?:\\s*(\\d+(?:\\.\\d+)?)\\s*(小時|h|H|分鐘|分)?)?';
const NOT_ADMIN = '這個指令只有管理員能用。';

export default {
  name: 'gate',
  scope: 'private',

  commands: [
    {
      name: 'gate-open',
      pattern: new RegExp(`^\\/開遊戲${DURATION}$`),
      describe: '/開遊戲 [2小時] — （管理員）打開遊戲大廳外網',
      type: 'query',
      handler: async (m, ctx) => {
        if (!isAdmin(ctx.userId)) return NOT_ADMIN;
        const hours = parseHours(m[1], m[2]);
        const r = await gate('start', ...(hours ? [String(hours)] : []));
        if (r.ok) {
          return [
            `🔓 遊戲大廳已開放外網，${r.closesAtText} 自動關閉（約 ${r.minutesLeft} 分鐘）`,
            `🌐 ${r.url}/`,
            '要延長傳「/延長 1小時」，提早關傳「/關遊戲」。',
            '關閉後打開網址會看到 Cloudflare 錯誤頁，是正常的。',
          ].join('\n');
        }
        if (r.reason === 'already') return `已經是開的，${r.minutesLeft} 分鐘後關。要延長傳「/延長 1小時」。`;
        if (r.reason === 'quiet') return '🌙 22:00～06:00 是休息時間，不能開外網。';
        return `⚠️ 開啟失敗：${r.message || r.reason}`;
      },
    },
    {
      name: 'gate-close',
      pattern: /^\/關遊戲$/,
      describe: '/關遊戲 — （管理員）關閉遊戲大廳外網',
      type: 'query',
      handler: async (_m, ctx) => {
        if (!isAdmin(ctx.userId)) return NOT_ADMIN;
        const r = await gate('stop');
        if (!r.ok) return `⚠️ 關閉失敗：${r.message || r.reason}`;
        return r.wasOpen ? '🔒 已關閉外網。區網照常可以玩。' : '本來就是關的。';
      },
    },
    {
      name: 'gate-status',
      pattern: /^\/遊戲狀態$/,
      describe: '/遊戲狀態 — （管理員）查看遊戲大廳是否開放',
      type: 'query',
      handler: async (_m, ctx) => {
        if (!isAdmin(ctx.userId)) return NOT_ADMIN;
        const r = await gate('status');
        if (!r.ok) return `⚠️ 查詢失敗：${r.message || r.reason}`;
        return r.open
          ? `🔓 外網開放中，${r.closesAtText} 關閉（還剩 ${r.minutesLeft} 分鐘）\n🌐 ${r.url}/`
          : `🔒 外網目前關閉。\n🏠 家裡 Wi-Fi：${LAN_URL}`;
      },
    },
    {
      name: 'gate-extend',
      pattern: new RegExp(`^\\/延長${DURATION}$`),
      describe: '/延長 [1小時] — （管理員）延後遊戲大廳關閉時間',
      type: 'query',
      handler: async (m, ctx) => {
        if (!isAdmin(ctx.userId)) return NOT_ADMIN;
        const hours = parseHours(m[1], m[2]) ?? 1;
        const r = await gate('extend', String(hours));
        if (!r.ok) return r.reason === 'closed' ? '外網目前是關的，請用「/開遊戲」。' : `⚠️ 延長失敗：${r.message || r.reason}`;
        return `⏰ 改成 ${r.closesAtText} 關閉（還剩 ${r.minutesLeft} 分鐘）${r.capped ? '\n已到上限：最晚 22:00、開門後最多 6 小時。' : ''}`;
      },
    },
  ],
};
