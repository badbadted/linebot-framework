/**
 * 妞揪 Plugin — LINE BOT 整合
 *
 * 提供活動查詢、報名、個人活動列表等功能
 * Firebase Project: sipangzi003
 */

import { initFirestore, getActiveEvents, findEventByTitle, getPlatformStats, getUpcomingEventsWithParticipants, getParticipantsForEvents, getTomorrowEvents, addPendingRestaurant, findRestaurantByUrl, getUserByDisplayName, updateRestaurant, getPendingRestaurants } from './firestore.js';
import { initGemini, isGeminiReady, resolveAndEnrich } from './gemini.js';

const ADMIN_USER_ID = process.env.NJ_ADMIN_USER_ID || '';

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

    // 批次查詢所有活動的參加名單
    const eventIds = events.map(e => e.id);
    const participantsMap = await getParticipantsForEvents(db, eventIds);

    const lines = ['🎯 本週活動：', ''];
    events.forEach((event, i) => {
      lines.push(`${i + 1}. ${event.title}`);
      const date = formatDate(event.startDate);
      const time = formatTimeRange(event.startTime, event.endTime);
      const dateTime = time ? `${date} ${time}` : date;
      lines.push(`   ${formatEventStatus(event.status)} | ${dateTime}`);
      if (event.location) lines.push(`   📍 ${event.location}`);

      // 參加名單
      const participants = participantsMap.get(event.id) || [];
      if (participants.length > 0) {
        const totalAdults = participants.reduce((s, p) => s + p.adults, 0);
        const totalKids = participants.reduce((s, p) => s + p.kids, 0);
        lines.push(`   👥 ${participants.length} 組（大人 ${totalAdults} / 小孩 ${totalKids}）`);
        for (const p of participants) {
          const parts = [];
          if (p.adults) parts.push(`大${p.adults}`);
          if (p.kids) parts.push(`小${p.kids}`);
          const count = parts.length > 0 ? ` (${parts.join('+')})` : '';
          const note = p.note ? ` 📝${p.note}` : '';
          lines.push(`      • ${p.userName}${count}${note}`);
        }
      } else {
        lines.push(`   👥 尚無人報名`);
      }
      lines.push('');
    });

    return lines.join('\n').trimEnd();
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
 * 查詢未來 N 小時內的活動，推播摘要給管理員
 * 預設 24 小時，測試時可用 /nj_remind <hours> 指定
 */
async function remindUpcomingEvents({ lineApi, hours, replyUserId }) {
  const pushTo = replyUserId || ADMIN_USER_ID;
  if (!pushTo) {
    console.error('[niujiu] remind: 沒有設定 NJ_ADMIN_USER_ID，無法推播');
    return;
  }

  try {
    const lookAhead = hours || 24;
    const items = await getUpcomingEventsWithParticipants(db, lookAhead);

    if (items.length === 0) {
      const msg = `📭 未來 ${lookAhead} 小時沒有活動`;
      console.log(`[niujiu] remind: ${msg}`);
      if (replyUserId) return msg; // 指令呼叫時回傳文字
      await lineApi.push(pushTo, msg);
      return;
    }

    const lines = ['🔔 活動提醒', ''];
    for (const { event, userIds } of items) {
      const time = formatTimeRange(event.startTime, event.endTime);
      lines.push(`📌 ${event.title}`);
      lines.push(`📅 ${formatDate(event.startDate)}${time ? ' ' + time : ''}`);
      if (event.location) lines.push(`📍 ${event.location}`);
      lines.push(`👥 已報名 ${userIds.length} 人`);
      lines.push('');
    }

    const msg = lines.join('\n').trim();
    console.log(`[niujiu] remind: ${items.length} 個活動，推播給 ${pushTo.slice(0, 8)}...`);

    if (replyUserId) return msg; // 指令呼叫時直接回傳
    await lineApi.push(pushTo, msg);
  } catch (err) {
    console.error('[niujiu] remind error:', err);
  }
}

// ── 排程：明日活動提醒（晚上 8 點推播到群組）─────────────

const NOTIFY_GROUP_ID = process.env.NJ_NOTIFY_GROUP_ID || 'C4d42b6072ca86ea3596875949ad37675'; // 妞揪群組

async function remindTomorrowEvents({ lineApi }) {
  try {
    const { active, cancelled } = await getTomorrowEvents(db);

    // 沒活動也沒取消就不推
    if (active.length === 0 && cancelled.length === 0) {
      console.log('[niujiu] tomorrow-remind: 明天沒有活動，不推播');
      return;
    }

    const lines = ['📅 明日活動提醒', ''];

    // 進行中的活動
    if (active.length > 0) {
      active.forEach((item, i) => {
        const { event, participantCount } = item;
        const time = formatTimeRange(event.startTime, event.endTime);
        lines.push(`${i + 1}. ${event.title}`);
        const parts = [];
        if (time) parts.push(`🕐 ${time}`);
        if (event.location) parts.push(`📍 ${event.location}`);
        lines.push(`   ${parts.join(' | ')}`);
        lines.push(`   👥 ${participantCount} 組報名`);
        lines.push('');
      });
    }

    // 已取消的活動
    if (cancelled.length > 0) {
      lines.push('──── 已取消 ────');
      for (const event of cancelled) {
        const time = formatTimeRange(event.startTime, event.endTime);
        lines.push(`❌ ${event.title}`);
        if (time) lines.push(`   🕐 ${time}`);
        lines.push('');
      }
    }

    const msg = lines.join('\n').trimEnd();
    console.log(`[niujiu] tomorrow-remind: ${active.length} 活動 + ${cancelled.length} 取消，推播到群組`);

    await lineApi.push(NOTIFY_GROUP_ID, msg);
  } catch (err) {
    console.error('[niujiu] tomorrow-remind error:', err);
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
      describe: '/nj_remind [小時] — 查看即將到來的活動提醒',
      handler: async (match, ctx) => {
        const hours = parseInt(match[1]) || 240;
        return await remindUpcomingEvents({ lineApi: ctx.lineApi, hours, replyUserId: ctx.userId });
      },
      scope: 'private',
    },
    {
      name: 'resolve',
      command: 'resolve',
      describe: '/nj_resolve — 批次解析所有 pending 餐廳（管理員）',
      handler: async (_match, ctx) => {
        if (!isGeminiReady()) {
          return '⚠️ Gemini 未設定（缺 GEMINI_API_KEY）';
        }

        const pending = await getPendingRestaurants(db);
        if (pending.length === 0) {
          return '📋 沒有待解析的餐廳';
        }

        const lines = [`🔄 開始解析 ${pending.length} 筆...`];
        let ok = 0, fail = 0;

        for (const restaurant of pending) {
          const url = restaurant.googleMapsUrl?.trim();
          if (!url) {
            await updateRestaurant(db, restaurant.id, { status: 'failed' });
            fail++;
            continue;
          }

          try {
            const result = await resolveAndEnrich(url);
            if (result.status === 'resolved' && result.name) {
              const { status, ...fields } = result;
              await updateRestaurant(db, restaurant.id, { ...fields, status: 'resolved' });
              lines.push(`✓ ${result.name}`);
              ok++;
            } else {
              await updateRestaurant(db, restaurant.id, { status: 'failed' });
              lines.push(`✗ ${url.slice(0, 40)}...`);
              fail++;
            }
          } catch (err) {
            await updateRestaurant(db, restaurant.id, { status: 'failed' });
            lines.push(`✗ ${url.slice(0, 40)}... (${err.message})`);
            fail++;
          }

          // Rate limit
          await new Promise(r => setTimeout(r, 2000));
        }

        lines.push('');
        lines.push(`✅ ${ok} 成功 / ❌ ${fail} 失敗`);
        return lines.join('\n');
      },
      scope: 'private',
    },
  ],

  defaultCommand: 'list',

  schedules: [
    {
      name: 'niujiu-tomorrow-remind',
      cron: '0 20 * * *',  // 每天晚上 8 點
      handler: remindTomorrowEvents,
      describe: '明日活動提醒：晚上 8 點推播明天的活動到妞揪群組',
      pushTo: [
        { type: 'group', id: NOTIFY_GROUP_ID, label: '妞揪群組' },
      ],
    },
  ],

  async init(ctx) {
    const lineApi = ctx.lineApi;

    try {
      db = await initFirestore();
      console.log('[niujiu] Firestore 連線成功（sipangzi003）');
    } catch (err) {
      console.error('[niujiu] Firestore 連線失敗:', err.message);
      throw err;
    }

    // Gemini AI（選用，沒有 key 就 fallback 到 pending 模式）
    initGemini();

    // ── /加美 指令：加入美食記錄 ──
    const router = ctx.router;
    router.add(/^\/加美\s+(.+)$/i, async (match, rctx) => {
      const input = match[1].trim();
      const urlMatch = input.match(/(https?:\/\/\S+)/i);
      if (!urlMatch) {
        return '請貼上連結\n範例：/加美 https://maps.app.goo.gl/xxxxx';
      }
      const foodUrl = urlMatch[1];

      try {
        const lineProfile = await rctx.lineApi.getProfile(rctx.userId);
        const displayName = lineProfile?.displayName || '';
        const njUser = displayName ? await getUserByDisplayName(db, displayName) : null;
        if (!njUser) {
          return '請先登入妞揪 App 才能使用美食記錄功能 🔒';
        }

        const existing = await findRestaurantByUrl(db, foodUrl);
        if (existing) {
          const name = existing.name || '（解析中）';
          return `這間已經記錄過了 😋\n📍 ${name}`;
        }

        const profile = {
          userId: njUser.id,
          displayName: njUser.displayName || displayName,
          pictureUrl: njUser.avatarUrl || lineProfile?.pictureUrl,
        };

        if (isGeminiReady()) {
          try {
            const result = await resolveAndEnrich(foodUrl);
            if (result.status === 'resolved' && result.name) {
              const { status, ...fields } = result;
              const docId = await addPendingRestaurant(db, foodUrl, profile);
              await updateRestaurant(db, docId, { ...fields, status: 'resolved' });
              const parts = [`✅ 已新增：${result.name}`];
              if (result.area) parts.push(`📍 ${result.area}`);
              if (result.googleRating) parts.push(`⭐ ${result.googleRating}`);
              if (result.priceDetail) parts.push(`💰 ${result.priceDetail}`);
              return parts.join('\n');
            } else {
              return '❌ 無法辨識餐廳，請確認連結是否正確';
            }
          } catch (err) {
            console.error('[niujiu] resolve error:', err.message);
            return '❌ 辨識失敗，請稍後再試';
          }
        }

        const docId = await addPendingRestaurant(db, foodUrl, profile);
        return `已加入美食記錄 🍜\n店名與資訊稍後自動補上！\n（ID: ${docId.slice(0, 6)}）`;
      } catch (err) {
        console.error('[niujiu] handleFood error:', err);
        return '⚠️ 加入失敗，請稍後再試';
      }
    }, {
      type: 'query',
      name: 'food',
      plugin: 'niujiu',
      describe: '/加美 <連結> — 加入美食記錄',
      scope: 'all',
    });

    // ── onSnapshot：即時監聽活動變更（取消通知 + 即將額滿通知）──
    const notifiedCancels = new Set();
    const notifiedAlmostFull = new Set(); // 每個活動只通知一次
    let isInitialSnapshot = true;

    db.collection('events').onSnapshot(snapshot => {
      if (isInitialSnapshot) {
        for (const doc of snapshot.docs) {
          const d = doc.data();
          if (d.status === 'cancelled') notifiedCancels.add(doc.id);
          // 已經快滿的不重複通知
          if (d.maxParticipants > 0 && d.currentParticipants >= d.maxParticipants - 1) {
            notifiedAlmostFull.add(doc.id);
          }
        }
        isInitialSnapshot = false;
        console.log(`[niujiu] onSnapshot ready, ${notifiedCancels.size} cancels, ${notifiedAlmostFull.size} almost-full tracked`);
        return;
      }

      for (const change of snapshot.docChanges()) {
        if (change.type !== 'modified') continue;
        const event = { id: change.doc.id, ...change.doc.data() };

        // ── 取消通知 ──
        if (event.status === 'cancelled' && !notifiedCancels.has(event.id)) {
          notifiedCancels.add(event.id);
          const time = formatTimeRange(event.startTime, event.endTime);
          const lines = [
            '❌ 活動取消通知',
            '',
            `「${event.title}」已取消`,
          ];
          if (event.startDate) {
            lines.push(`原定時間：${formatDate(event.startDate)}${time ? ' ' + time : ''}`);
          }
          console.log(`[niujiu] cancel-notify: ${event.title}`);
          lineApi.push(NOTIFY_GROUP_ID, lines.join('\n')).catch(err => {
            console.error(`[niujiu] cancel-notify push error: ${err.message}`);
          });
        }

        // ── 即將額滿通知（只差 1 人）──
        if (event.maxParticipants > 0
          && event.currentParticipants === event.maxParticipants - 1
          && !notifiedAlmostFull.has(event.id)
          && ['voting', 'upcoming', 'ongoing'].includes(event.status)) {
          notifiedAlmostFull.add(event.id);
          const time = formatTimeRange(event.startTime, event.endTime);
          const lines = [
            '🔥 即將額滿！',
            '',
            `「${event.title}」只剩 1 個名額`,
            `👥 ${event.currentParticipants}/${event.maxParticipants}`,
          ];
          if (event.startDate) {
            lines.push(`📅 ${formatDate(event.startDate)}${time ? ' ' + time : ''}`);
          }
          console.log(`[niujiu] almost-full: ${event.title} (${event.currentParticipants}/${event.maxParticipants})`);
          lineApi.push(NOTIFY_GROUP_ID, lines.join('\n')).catch(err => {
            console.error(`[niujiu] almost-full push error: ${err.message}`);
          });
        }
      }
    }, err => {
      console.error('[niujiu] onSnapshot error:', err.message);
    });
  },
};
