/**
 * Routines Plugin — 例行事項推播
 *
 * 前綴：/rt
 *
 * 讀取 Mac mini 上的 routines.md，每分鐘比對時間：
 * - 例行事項：週一到五 07:20 | 內容 → 匹配星期+時間
 * - 單次事項：2026/03/19 13:35 | 內容 → 匹配日期+時間
 *
 * 匹配後透過 LINE Push API 推播給預設使用者。
 * TTS 語音播報仍由 routines-daemon.py 負責。
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const ROUTINES_PATH = resolve(homedir(), '.openclaw/workspace/routines.md');
const PUSH_USER_ID = process.env.PUSH_USER_ID || '';

// 中文星期對照（getDay: 0=日, 1=一, ...）
const WEEKDAY_MAP = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

// 已推播記錄（防止重啟後同分鐘重複推）
const firedSet = new Set();

// ── 星期解析 ─────────────────────────────────────────

/**
 * 解析星期字串，回傳 getDay() 數字陣列
 * 支援格式：
 *   週一到五 → [1,2,3,4,5]
 *   週一三五 → [1,3,5]
 *   每天     → [0,1,2,3,4,5,6]
 */
function parseWeekdays(text) {
  if (text === '每天') return [0, 1, 2, 3, 4, 5, 6];

  // 「到」表示範圍：週一到五
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

  // 列舉：週一三五
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

    // 只處理已啟用的項目 [x]
    if (!trimmed.startsWith('- [x]')) continue;

    const body = trimmed.slice(5).trim(); // 去掉 "- [x] "
    const parts = body.split('|').map(s => s.trim());
    if (parts.length < 2) continue;

    const timePart = parts[0];
    const message = parts.slice(1).join('|').trim();

    if (section === 'recurring') {
      // 格式：週一到五 07:20
      const match = timePart.match(/^(.+?)\s+(\d{1,2}):(\d{2})$/);
      if (match) {
        recurring.push({
          weekdays: parseWeekdays(match[1]),
          hour: parseInt(match[2]),
          minute: parseInt(match[3]),
          message,
          raw: timePart,
        });
      }
    } else if (section === 'oneshot') {
      // 格式：2026/03/19 13:35
      const match = timePart.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
      if (match) {
        oneshot.push({
          year: parseInt(match[1]),
          month: parseInt(match[2]),
          day: parseInt(match[3]),
          hour: parseInt(match[4]),
          minute: parseInt(match[5]),
          message,
          raw: timePart,
        });
      }
    }
  }

  return { recurring, oneshot };
}

// ── 時間比對 ─────────────────────────────────────────

function getMatchingRoutines() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const currentDay = now.getDay();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentDate = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;

  const { recurring, oneshot } = parseRoutinesFile();
  const matched = [];

  // 比對例行事項
  for (const r of recurring) {
    if (r.weekdays.includes(currentDay) && r.hour === currentHour && r.minute === currentMinute) {
      const key = `recurring:${r.raw}:${currentDate}:${currentHour}:${currentMinute}`;
      if (!firedSet.has(key)) {
        matched.push({ type: 'recurring', ...r, key });
      }
    }
  }

  // 比對單次事項
  for (const o of oneshot) {
    if (o.year === now.getFullYear() && o.month === (now.getMonth() + 1) && o.day === now.getDate()
        && o.hour === currentHour && o.minute === currentMinute) {
      const key = `oneshot:${o.raw}`;
      if (!firedSet.has(key)) {
        matched.push({ type: 'oneshot', ...o, key });
      }
    }
  }

  return matched;
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
      const time = `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
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

// 定期清理 firedSet（保留 2 小時內的記錄）
setInterval(() => {
  if (firedSet.size > 100) firedSet.clear();
}, 2 * 60 * 60 * 1000);

// ── Plugin 定義 ──────────────────────────────────────

export default {
  name: 'routines',
  prefix: 'rt',
  description: '例行事項 — 定時推播提醒',
  version: '1.0.0',
  defaultCommand: 'list-routines',

  commands: [
    {
      name: 'list-routines',
      command: 'list',
      describe: '/rt — 查看例行事項清單',
      handler: async (_match, _ctx) => {
        return formatRoutinesList();
      },
      scope: 'private',
    },
    {
      name: 'check-routines',
      command: 'check',
      describe: '/rt_check — 手動檢查現在是否有匹配的事項',
      handler: async (_match, ctx) => {
        const matched = getMatchingRoutines();
        if (matched.length === 0) {
          return '✅ 目前沒有匹配的例行事項';
        }
        const lines = ['🔔 目前匹配的事項：'];
        for (const m of matched) {
          lines.push(`  ${m.type === 'recurring' ? '📅' : '📌'} ${m.message}`);
        }
        return lines.join('\n');
      },
      scope: 'private',
    },
  ],

  schedules: [
    {
      name: 'routines-check',
      cron: '* * * * *',  // 每分鐘檢查
      describe: '例行事項推播：每分鐘比對 routines.md，匹配就推 LINE',
      pushTo: [
        { type: 'user', id: PUSH_USER_ID || '(env: PUSH_USER_ID)', label: '預設使用者' },
      ],
      handler: async ({ lineApi }) => {
        if (!PUSH_USER_ID) {
          console.warn('[routines] PUSH_USER_ID 未設定，跳過推播');
          return;
        }

        const matched = getMatchingRoutines();
        if (matched.length === 0) return;

        for (const m of matched) {
          const emoji = m.type === 'recurring' ? '📅' : '📌';
          const msg = `${emoji} ${m.message}`;

          try {
            await lineApi.push(PUSH_USER_ID, msg);
            firedSet.add(m.key);
            console.log(`[routines] pushed: ${m.message}`);
          } catch (err) {
            console.error(`[routines] push error: ${err.message}`);
          }
        }
      },
    },
  ],

  init: async () => {
    // 驗證 routines.md 是否可讀
    try {
      const { recurring, oneshot } = parseRoutinesFile();
      console.log(`[routines] 載入成功：${recurring.length} 例行 + ${oneshot.length} 單次`);
    } catch (err) {
      console.warn(`[routines] 無法讀取 routines.md: ${err.message}`);
    }
  },
};
