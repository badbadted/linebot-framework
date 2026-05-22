/**
 * Routines Plugin — 例行事項推播
 *
 * 前綴：/rt
 *
 * 啟動時讀取 routines.md，每筆例行事項轉成精確 cron 排程：
 * - 週一到五 07:20 | 內容 → cron '20 7 * * 1-5'
 * - 單次事項用 scheduler.addOnce()
 *
 * TTS 語音播報仍由 routines-daemon.py 負責。
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const ROUTINES_PATH = resolve(homedir(), '.openclaw/workspace/routines.md');
const PUSH_USER_ID = process.env.PUSH_USER_ID || '';

// 中文星期對照（cron: 0=日, 1=一, ...）
const WEEKDAY_MAP = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

let scheduler;

// ── 星期解析 ─────────────────────────────────────────

/**
 * 解析星期字串，回傳 cron 用的 dow 陣列
 *   週一到五 → [1,2,3,4,5]
 *   週一三五 → [1,3,5]
 *   每天     → [0,1,2,3,4,5,6]
 */
function parseWeekdays(text) {
  if (text === '每天') return [0, 1, 2, 3, 4, 5, 6];

  const rangeMatch = text.match(/週(.)到(.)/);
  if (rangeMatch) {
    const start = WEEKDAY_MAP[rangeMatch[1]];
    const end = WEEKDAY_MAP[rangeMatch[2]];
    if (start !== undefined && end !== undefined) {
      const days = [];
      for (let i = start; i <= end; i++) days.push(i);
      return days;
    }
  }

  const enumMatch = text.match(/週(.+)/);
  if (enumMatch) {
    return [...enumMatch[1]].map(c => WEEKDAY_MAP[c]).filter(d => d !== undefined);
  }

  return [];
}

// ── 解析 routines.md ─────────────────────────────────

function parseRoutinesFile() {
  let content;
  try {
    content = readFileSync(ROUTINES_PATH, 'utf-8');
  } catch (err) {
    console.error(`[routines] 無法讀取 ${ROUTINES_PATH}: ${err.message}`);
    return { recurring: [], oneshot: [] };
  }

  const recurring = [];
  const oneshot = [];
  let section = '';

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '## 例行') { section = 'recurring'; continue; }
    if (trimmed === '## 單次') { section = 'oneshot'; continue; }
    if (trimmed.startsWith('## ')) { section = ''; continue; }

    if (!trimmed.startsWith('- [x]')) continue;

    const body = trimmed.slice(5).trim();
    const parts = body.split('|').map(s => s.trim());
    if (parts.length < 2) continue;

    const timePart = parts[0];
    const message = parts.slice(1).join('|').trim();

    if (section === 'recurring') {
      const match = timePart.match(/^(.+?)\s+(\d{1,2}):(\d{2})$/);
      if (match) {
        const weekdays = parseWeekdays(match[1]);
        const hour = parseInt(match[2]);
        const minute = parseInt(match[3]);
        // 轉成 cron: "20 7 * * 1-5" 或 "20 7 * * 1,3,5"
        const dow = weekdays.join(',');
        const cron = `${minute} ${hour} * * ${dow}`;
        recurring.push({ cron, message, raw: timePart, weekdays, hour, minute });
      }
    } else if (section === 'oneshot') {
      const match = timePart.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
      if (match) {
        const dt = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
        oneshot.push({ datetime: dt, message, raw: timePart });
      }
    }
  }

  return { recurring, oneshot };
}

// ── 格式化顯示 ───────────────────────────────────────

function formatRoutinesList() {
  const { recurring, oneshot } = parseRoutinesFile();
  const lines = ['📋 例行事項'];

  if (recurring.length === 0 && oneshot.length === 0) {
    return '📋 沒有設定任何例行事項';
  }

  if (recurring.length > 0) {
    lines.push('', '📅 例行：');
    for (const r of recurring) {
      lines.push(`  ${r.raw} → ${r.message}`);
    }
  }

  if (oneshot.length > 0) {
    lines.push('', '📌 單次：');
    for (const o of oneshot) {
      lines.push(`  ${o.raw} → ${o.message}`);
    }
  }

  return lines.join('\n');
}

// ── 推播 handler ─────────────────────────────────────

function createPushHandler(message, emoji) {
  return async ({ lineApi }) => {
    if (!PUSH_USER_ID) {
      console.warn('[routines] PUSH_USER_ID 未設定，跳過推播');
      return;
    }
    const msg = `${emoji} ${message}`;
    try {
      await lineApi.push(PUSH_USER_ID, msg);
      console.log(`[routines] pushed: ${message}`);
    } catch (err) {
      console.error(`[routines] push error: ${err.message}`);
    }
  };
}

// ── Plugin 定義 ──────────────────────────────────────

export default {
  name: 'routines',
  prefix: 'rt',
  description: '例行事項 — 定時推播提醒',
  version: '1.1.0',
  defaultCommand: 'list-routines',

  commands: [
    {
      name: 'list-routines',
      command: 'list',
      describe: '/rt — 查看例行事項清單',
      handler: async (_match, _ctx) => formatRoutinesList(),
      scope: 'private',
    },
  ],

  // 不用靜態 schedules — init 時動態註冊精確時間
  schedules: [],

  init: async (ctx) => {
    scheduler = ctx.scheduler;
    const { recurring, oneshot } = parseRoutinesFile();

    // 例行 → 精確 cron
    for (let i = 0; i < recurring.length; i++) {
      const r = recurring[i];
      const name = `rt-${i}-${r.hour}${String(r.minute).padStart(2, '0')}`;
      scheduler.add(name, r.cron, createPushHandler(r.message, '📅'), {
        plugin: 'routines',
        describe: `例行推播：${r.raw} → ${r.message}`,
        pushTo: [{ type: 'user', id: PUSH_USER_ID || '(env: PUSH_USER_ID)', label: '預設使用者' }],
      });
    }

    // 單次 → addOnce
    for (let i = 0; i < oneshot.length; i++) {
      const o = oneshot[i];
      if (o.datetime > new Date()) {
        const name = `rt-once-${i}`;
        scheduler.addOnce(name, o.datetime, createPushHandler(o.message, '📌'), {
          plugin: 'routines',
        });
      }
    }

    console.log(`[routines] 註冊 ${recurring.length} 例行 + ${oneshot.filter(o => o.datetime > new Date()).length} 單次排程`);
  },
};
