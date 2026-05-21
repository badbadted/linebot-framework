/**
 * 妞揪 Plugin — LINE BOT 整合
 *
 * 提供活動查詢、報名、個人活動列表等功能
 * Firebase Project: sipangzi003
 */

import { initFirestore, getActiveEvents, findEventByTitle, getMyEvents, getPlatformStats, getUpcomingEventsWithParticipants } from './firestore.js';

let db = null;

// ── 格式化工具 ────────────────────────────────────────

function formatDate(timestamp) {
  if (!timestamp) return '未定';
  const d = typeof timestamp === 'number' ? new Date(timestamp)
    : timestamp.toDate ? timestamp.toDate()
    : new Date(timestamp);
  if (isNaN(d.getTime())) return '未定';
  return `${d.getMonth() + 1}/${d.getDate()}(${['日', '一', '二', '三', '四', '五', '六'][d.getDay()]})`;
}

function formatTimeRange(startTime, endTime) {
  if (!startTime) return '';
  if (endTime) return `${startTime}-${endTime}`;
  return startTime;
}

function formatEventStatus(status) {
  const map = {
    voting: '🗳️ 投票中',
    upcoming: '📅 即將開始',
    ongoing: '🎉 進行中',
    ended: '✅ 已結束',
    cancelled: '❌ 已取消',
    draft: '📝 草稿',
  };
  return map[status] || status;
}

function formatEventCard(event) {
  const lines = [];
  lines.push(`📌 ${event.title}`);
  lines.push(`狀態：${formatEventStatus(event.status)}`);
  if (event.startDate) {
    const time = formatTimeRange(event.startTime, event.endTime);
    lines.push(`日期：${formatDate(event.startDate)}${time ? ' ' + time : ''}`);
  }
  if (event.location) lines.push(`地點：${event.location}`);
  if (event.maxParticipants) {
    lines.push(`人數：${event.currentParticipants || 0}/${event.maxParticipants}`);
  } else {
    lines.push(`已報名：${event.currentParticipants || 0} 人`);
  }
  if (event.feeMode && event.feeMode !== 'free') {
    lines.push(`費用：${event.feeAmount ? `$${event.feeAmount}` : '見說明'}`);
  }
  return lines.join('\n');
}

// ── 指令處理 ────────────────────────────────────────

/**
 * /nj — 列出近期活動
 * handler 簽名：(match, ctx) => string
 */
async function handleList(match, ctx) {
  try {
    const events = await getActiveEvents(db, 5);

    if (events.length === 0) {
      return '目前沒有進行中的活動 🎈\n有新活動時會通知你！';
    }

    const lines = ['🎯 近期活動：', ''];
    events.forEach((event, i) => {
      lines.push(`${i + 1}. ${event.title}`);
      const date = formatDate(event.startDate);
      const time = formatTimeRange(event.startTime, event.endTime);
      const dateTime = time ? `${date} ${time}` : date;
      lines.push(`   ${formatEventStatus(event.status)} | ${dateTime}`);
      if (event.location) lines.push(`   📍 ${event.location}`);
      lines.push('');
    });

    lines.push('💡 輸入 /nj_info <活動名> 查看詳情');
    return lines.join('\n');
  } catch (err) {
    console.error('[niujiu] handleList error:', err);
    return '⚠️ 查詢活動時發生錯誤，請稍後再試';
  }
}

/**
 * /nj_info <活動名稱> — 查看活動詳情
 */
async function handleInfo(match, ctx) {
  const keyword = match[1]?.trim();
  if (!keyword) {
    return '請輸入活動名稱\n範例：/nj_info 親子露營';
  }

  try {
    const event = await findEventByTitle(db, keyword);
    if (!event) {
      return `找不到「${keyword}」相關活動 🤔\n輸入 /nj 查看目前活動列表`;
    }

    const lines = [formatEventCard(event)];

    if (event.description) {
      const desc = event.description.length > 100
        ? event.description.substring(0, 100) + '...'
        : event.description;
      lines.push('');
      lines.push(`📝 ${desc}`);
    }

    if (event.tags && event.tags.length > 0) {
      lines.push('');
      lines.push(`🏷️ ${event.tags.join(' ')}`);
    }

    // 報名提示
    if (['voting', 'upcoming'].includes(event.status)) {
      lines.push('');
      lines.push(`👉 輸入 /nj_join ${event.title} 報名參加`);
    }

    return lines.join('\n');
  } catch (err) {
    console.error('[niujiu] handleInfo error:', err);
    return '⚠️ 查詢活動詳情時發生錯誤，請稍後再試';
  }
}

/**
 * /nj_my — 我的活動
 */
async function handleMyEvents(match, ctx) {
  const userId = ctx.event.source.userId;

  try {
    const events = await getMyEvents(db, userId);

    if (events.length === 0) {
      return '你還沒有報名任何活動 📭\n輸入 /nj 看看有什麼好玩的！';
    }

    const lines = ['📋 我的活動：', ''];
    events.forEach((event, i) => {
      lines.push(`${i + 1}. ${event.title}`);
      lines.push(`   ${formatEventStatus(event.status)} | ${formatDate(event.startDate) || '日期未定'}`);
      lines.push('');
    });

    return lines.join('\n');
  } catch (err) {
    console.error('[niujiu] handleMyEvents error:', err);
    return '⚠️ 查詢活動時發生錯誤，請稍後再試';
  }
}

/**
 * /nj_stats — 平台統計（管理員）
 */
async function handleStats(match, ctx) {
  try {
    const stats = await getPlatformStats(db);

    const lines = [
      '📊 妞揪平台統計',
      '',
      `活動總數：${stats.totalEvents}`,
      `進行中：${stats.activeEvents}`,
      `註冊會員：${stats.totalUsers}`,
      '',
      '📈 近 30 天',
      `新活動：${stats.monthlyNewEvents}`,
      `新會員：${stats.monthlyNewUsers}`,
    ];

    return lines.join('\n');
  } catch (err) {
    console.error('[niujiu] handleStats error:', err);
    return '⚠️ 查詢統計時發生錯誤，請稍後再試';
  }
}

// ── 排程：活動提醒推播 ──────────────────────────────────

/**
 * 查詢未來 N 小時內的活動，推播提醒給已報名的參與者
 * 預設 24 小時，測試時可用 /nj_remind <hours> 指定
 */
async function remindUpcomingEvents({ lineApi, hours }) {
  try {
    const lookAhead = hours || 24;
    const items = await getUpcomingEventsWithParticipants(db, lookAhead);

    if (items.length === 0) {
      console.log(`[niujiu] remind: 未來 ${lookAhead} 小時沒有活動`);
      return;
    }

    for (const { event, userIds } of items) {
      if (userIds.length === 0) continue;

      const time = formatTimeRange(event.startTime, event.endTime);
      const lines = [
        '🔔 活動提醒',
        '',
        `📌 ${event.title}`,
        `📅 ${formatDate(event.startDate)}${time ? ' ' + time : ''}`,
        event.location ? `📍 ${event.location}` : '',
        '',
        '記得準時出席喔！',
      ].filter(Boolean);

      const msg = lines.join('\n');

      // 逐一推播（避免 multicast 500 人上限問題）
      for (const userId of userIds) {
        try {
          await lineApi.push(userId, msg);
        } catch (err) {
          console.error(`[niujiu] remind push failed for ${userId}: ${err.message}`);
        }
      }

      console.log(`[niujiu] remind: 「${event.title}」推播 ${userIds.length} 人`);
    }
  } catch (err) {
    console.error('[niujiu] remind error:', err);
  }
}

// ── Plugin 定義 ──────────────────────────────────────

export default {
  name: 'niujiu',
  prefix: 'nj',
  description: '妞揪 — 親子活動揪團',
  version: '1.0.0',

  commands: [
    {
      name: 'list',
      command: 'list',
      describe: '/nj — 列出近期活動',
      handler: handleList,
      scope: 'all',
    },
    {
      name: 'info',
      command: 'info',
      pattern: /^(.+)/,
      describe: '/nj_info <活動名稱> — 查看活動詳情',
      handler: handleInfo,
      scope: 'all',
    },
    {
      name: 'my',
      command: 'my',
      describe: '/nj_my — 我的已報名活動',
      handler: handleMyEvents,
      scope: 'all',
    },
    {
      name: 'stats',
      command: 'stats',
      describe: '/nj_stats — 平台統計（管理員）',
      handler: handleStats,
      scope: 'private',
    },
    {
      name: 'remind',
      command: 'remind',
      pattern: /^(\d+)?/,
      describe: '/nj_remind [小時] — 手動觸發活動提醒（管理員測試）',
      handler: async (match, ctx) => {
        const hours = parseInt(match[1]) || 240;
        await remindUpcomingEvents({ lineApi: ctx.lineApi, hours });
        return `✅ 提醒推播已觸發（查詢未來 ${hours} 小時的活動）`;
      },
      scope: 'private',
    },
  ],

  defaultCommand: 'list',

  schedules: [
    {
      name: 'niujiu-event-remind',
      cron: '0 8 * * *',  // 每天早上 8 點
      handler: remindUpcomingEvents,
    },
  ],

  async init() {
    try {
      db = await initFirestore();
      console.log('[niujiu] Firestore 連線成功（sipangzi003）');
    } catch (err) {
      console.error('[niujiu] Firestore 連線失敗:', err.message);
      throw err;
    }
  },
};
