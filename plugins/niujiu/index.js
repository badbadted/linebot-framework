/**
 * 妞揪 Plugin — LINE BOT 整合
 *
 * 提供活動查詢、報名、個人活動列表等功能
 * Firebase Project: sipangzi003
 */

import { initFirestore, getActiveEvents, findEventByTitle, getMyEvents, getUser, hasJoined, joinEvent, getPlatformStats } from './firestore.js';

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
 * /nj_join <活動名稱> — 快速報名
 */
async function handleJoin(match, ctx) {
  const keyword = match[1]?.trim();
  if (!keyword) {
    return '請輸入要報名的活動名稱\n範例：/nj_join 親子露營';
  }

  const userId = ctx.event.source.userId;

  try {
    // 查活動
    const event = await findEventByTitle(db, keyword);
    if (!event) {
      return `找不到「${keyword}」相關活動 🤔\n輸入 /nj 查看目前活動列表`;
    }

    // 檢查狀態
    if (!['voting', 'upcoming'].includes(event.status)) {
      return `「${event.title}」目前${formatEventStatus(event.status)}，無法報名`;
    }

    // 檢查人數上限
    if (event.maxParticipants && event.currentParticipants >= event.maxParticipants) {
      return `「${event.title}」已額滿（${event.currentParticipants}/${event.maxParticipants}）😢`;
    }

    // 檢查是否已報名
    const already = await hasJoined(db, event.id, userId);
    if (already) {
      return `你已經報名「${event.title}」了 ✅\n輸入 /nj_my 查看你的活動`;
    }

    // 取得使用者資料
    const user = await getUser(db, userId);
    if (!user) {
      return '尚未在妞揪平台建立帳號\n請先從 LINE 選單開啟妞揪 App 登入一次';
    }

    // 執行報名
    await joinEvent(db, event, user);

    const lines = [
      `✅ 報名成功！`,
      '',
      `📌 ${event.title}`,
      event.startDate ? `📅 ${formatDate(event.startDate)}` : '',
      event.location ? `📍 ${event.location}` : '',
      '',
      '預設報名：大人 1 + 小孩 1',
      '如需修改人數，請到妞揪 App 調整',
    ].filter(Boolean);

    return lines.join('\n');
  } catch (err) {
    console.error('[niujiu] handleJoin error:', err);
    return '⚠️ 報名時發生錯誤，請稍後再試';
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
      name: 'join',
      command: 'join',
      pattern: /^(.+)/,
      describe: '/nj_join <活動名稱> — 快速報名活動',
      handler: handleJoin,
      scope: 'all',
    },
    {
      name: 'stats',
      command: 'stats',
      describe: '/nj_stats — 平台統計（管理員）',
      handler: handleStats,
      scope: 'private',
    },
  ],

  defaultCommand: 'list',

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
