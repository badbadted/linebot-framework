/**
 * 妞揪 Firestore 連線 + 查詢模組
 *
 * Firebase Project: sipangzi003
 * Collections: events, participants, dateVotes, comments, users, restaurants
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

let db = null;

// ── 初始化 ────────────────────────────────────────────

export async function initFirestore() {
  if (db) return db;

  const existing = getApps();
  let app;

  if (existing.length > 0) {
    app = existing[0];
  } else {
    const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (saPath) {
      const serviceAccount = JSON.parse(readFileSync(saPath, 'utf-8'));
      app = initializeApp({ credential: cert(serviceAccount) });
    } else {
      // 依賴 GOOGLE_APPLICATION_CREDENTIALS 環境變數
      app = initializeApp();
    }
  }

  db = getFirestore(app);
  return db;
}

// ── 活動查詢 ──────────────────────────────────────────

/**
 * 取得近期活動（voting + upcoming + ongoing）
 */
export async function getActiveEvents(db, limit = 5) {
  const snap = await db.collection('events')
    .where('status', 'in', ['voting', 'upcoming', 'ongoing'])
    .get();

  const now = Date.now();
  const events = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 過濾：只保留本週活動（週一～週日，從今天起算）
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = today.getDay(); // 0=日 1=一 ... 6=六
  const sundayEnd = new Date(today);
  sundayEnd.setDate(today.getDate() + (day === 0 ? 0 : 7 - day)); // 本週日
  sundayEnd.setHours(23, 59, 59, 999);

  const active = events.filter(e => {
    if (!e.startDate) return true; // 日期未定的保留
    const ts = typeof e.startDate === 'number' ? e.startDate
      : e.startDate.toMillis ? e.startDate.toMillis()
      : new Date(e.startDate).getTime();
    return ts >= today.getTime() && ts <= sundayEnd.getTime();
  });

  // 依活動日期+時間升序（同一天按 startTime 早→晚）
  active.sort((a, b) => {
    const tsA = getTimestamp(a.startDate);
    const tsB = getTimestamp(b.startDate);
    // 無日期的排最後
    if (!tsA) return 1;
    if (!tsB) return -1;
    if (tsA !== tsB) return tsA - tsB;
    // 同一天：按 startTime 排序（"09:00" < "20:00"）
    const tA = a.startTime || '99:99';
    const tB = b.startTime || '99:99';
    return tA.localeCompare(tB);
  });

  return active.slice(0, limit);
}

/**
 * 批次查詢多個活動的參與者名單
 * @returns Map<eventId, [{userId, userName, adults, kids, note}]>
 */
export async function getParticipantsForEvents(db, eventIds) {
  const result = new Map();
  for (const id of eventIds) result.set(id, []);

  // Firestore 'in' 一次最多 30 筆
  for (let i = 0; i < eventIds.length; i += 30) {
    const batch = eventIds.slice(i, i + 30);
    const snap = await db.collection('participants')
      .where('eventId', 'in', batch)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (result.has(d.eventId)) {
        result.get(d.eventId).push({
          userId: d.userId || '',
          userName: d.userName || '匿名',
          adults: d.adults || 0,
          kids: d.kids || 0,
          note: d.note || '',
        });
      }
    }
  }
  return result;
}

function getTimestamp(d) {
  if (!d) return null;
  if (typeof d === 'number') return d;
  if (d.toMillis) return d.toMillis();
  return new Date(d).getTime() || null;
}

/**
 * 用名稱模糊搜尋活動
 */
export async function findEventByTitle(db, keyword) {
  // Firestore 不支援 contains，先取活躍的再 client 端 filter
  const snap = await db.collection('events')
    .where('status', 'in', ['voting', 'upcoming', 'ongoing', 'ended'])
    .get();

  const events = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // 完全比對優先
  const exact = events.find(e => e.title === keyword);
  if (exact) return exact;

  // 模糊比對
  return events.find(e => e.title?.includes(keyword)) || null;
}

/**
 * 查詢使用者報名的活動
 */
export async function getMyEvents(db, userId) {
  const partSnap = await db.collection('participants')
    .where('userId', '==', userId)
    .get();

  if (partSnap.empty) return [];

  const eventIds = [...new Set(partSnap.docs.map(d => d.data().eventId))];

  // Firestore 'in' query 一次最多 30 筆
  const results = [];
  for (let i = 0; i < eventIds.length; i += 30) {
    const batch = eventIds.slice(i, i + 30);
    const eventSnap = await db.collection('events')
      .where('__name__', 'in', batch)
      .get();
    results.push(...eventSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  }

  return results;
}

/**
 * 查詢使用者（by LINE userId）
 */
export async function getUser(db, userId) {
  const doc = await db.collection('users').doc(userId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

/**
 * 用暱稱查詢使用者（LIFF 與 BOT userId 不同，改用 displayName 比對）
 */
export async function getUserByDisplayName(db, displayName) {
  const snap = await db.collection('users')
    .where('displayName', '==', displayName)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * 檢查是否已報名
 */
export async function hasJoined(db, eventId, userId) {
  const snap = await db.collection('participants')
    .where('eventId', '==', eventId)
    .where('userId', '==', userId)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * 報名活動（寫入 participant + 更新 event 人數）
 */
export async function joinEvent(db, event, user) {
  const participant = {
    eventId: event.id,
    userId: user.id,
    userName: user.displayName || user.name || '匿名',
    userAvatar: user.pictureUrl || user.avatar || '',
    adults: 1,
    kids: 1,
    joinedAt: Date.now(),
  };

  await db.collection('participants').add(participant);

  // 更新人數
  const eventRef = db.collection('events').doc(event.id);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(eventRef);
    const data = doc.data();
    const current = (data.currentParticipants || 0) + 2; // 大人1+小孩1
    const currentAdults = (data.currentAdults || 0) + 1;
    const currentKids = (data.currentKids || 0) + 1;
    tx.update(eventRef, { currentParticipants: current, currentAdults, currentKids });
  });

  return participant;
}

/**
 * 取得即將到來的活動及其參與者（用於提醒推播）
 * @param {number} withinHours - 幾小時內的活動（預設 24）
 */
export async function getUpcomingEventsWithParticipants(db, withinHours = 24) {
  const snap = await db.collection('events')
    .where('status', 'in', ['upcoming', 'ongoing'])
    .get();

  const now = Date.now();
  const cutoff = now + withinHours * 60 * 60 * 1000;

  const events = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 篩選：startDate 在 now ~ cutoff 之間
  const upcoming = events.filter(e => {
    const ts = getTimestamp(e.startDate);
    if (!ts) return false;
    return ts >= now && ts <= cutoff;
  });

  // 按時間排序（早→晚）
  upcoming.sort((a, b) => {
    const tA = a.startTime || '99:99';
    const tB = b.startTime || '99:99';
    return tA.localeCompare(tB);
  });

  // 查每個活動的參與者
  const results = [];
  for (const event of upcoming) {
    const partSnap = await db.collection('participants')
      .where('eventId', '==', event.id)
      .get();
    const userIds = partSnap.docs.map(d => d.data().userId).filter(Boolean);
    results.push({ event, userIds });
  }

  return results;
}

/**
 * 取得明日活動（含報名組數）+ 明日已取消的活動
 * @returns { active: [{event, participantCount}], cancelled: [event] }
 */
export async function getTomorrowEvents(db) {
  // 用台灣時區算「明天」的範圍
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrow);
  tomorrowEnd.setHours(23, 59, 59, 999);

  // 同時查活躍 + 已取消的活動
  const [activeSnap, cancelledSnap] = await Promise.all([
    db.collection('events')
      .where('status', 'in', ['voting', 'upcoming', 'ongoing'])
      .get(),
    db.collection('events')
      .where('status', '==', 'cancelled')
      .get(),
  ]);

  const isTomorrow = (e) => {
    const ts = getTimestamp(e.startDate);
    if (!ts) return false;
    return ts >= tomorrow.getTime() && ts <= tomorrowEnd.getTime();
  };

  const sortByTime = (a, b) => {
    const tA = a.startTime || '99:99';
    const tB = b.startTime || '99:99';
    return tA.localeCompare(tB);
  };

  // 活躍的明日活動
  const activeEvents = activeSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(isTomorrow);
  activeEvents.sort(sortByTime);

  const active = [];
  for (const event of activeEvents) {
    const partSnap = await db.collection('participants')
      .where('eventId', '==', event.id)
      .get();
    active.push({ event, participantCount: partSnap.size });
  }

  // 取消的明日活動
  const cancelled = cancelledSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(isTomorrow);
  cancelled.sort(sortByTime);

  return { active, cancelled };
}

/**
 * 平台統計
 */
export async function getPlatformStats(db) {
  const [eventsSnap, usersSnap] = await Promise.all([
    db.collection('events').get(),
    db.collection('users').get(),
  ]);

  const now = Date.now();
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  const events = eventsSnap.docs.map(d => d.data());
  const active = events.filter(e => ['voting', 'upcoming', 'ongoing'].includes(e.status));
  const recentEvents = events.filter(e => e.createdAt > monthAgo);
  const recentUsers = usersSnap.docs.filter(d => d.data().createdAt > monthAgo);

  return {
    totalEvents: events.length,
    activeEvents: active.length,
    totalUsers: usersSnap.size,
    monthlyNewEvents: recentEvents.length,
    monthlyNewUsers: recentUsers.length,
  };
}

// ── 美食記錄 ─────────────────────────────────────────

/** 從訊息文字抓出 Google Maps 連結（短連結 / 長連結都涵蓋） */
const MAPS_URL_RE = /(https?:\/\/(?:maps\.app\.goo\.gl|maps\.google\.[a-z.]+|(?:www\.)?google\.[a-z.]+\/maps)\/\S+)/i;

export function extractMapsUrl(text) {
  return text.match(MAPS_URL_RE)?.[1] ?? null;
}

/**
 * 寫一筆 pending 餐廳到 restaurants collection
 * @param {object} profile - { userId, displayName, pictureUrl? }
 * @returns {string} docId
 */
export async function addPendingRestaurant(db, mapsUrl, profile) {
  const recommender = { uid: profile.userId, name: profile.displayName };
  if (profile.pictureUrl) recommender.avatarUrl = profile.pictureUrl;

  const now = Date.now();
  const doc = {
    googleMapsUrl: mapsUrl,
    name: '',
    status: 'pending',
    recommenders: [recommender],
    cuisineTypes: [],
    photos: [],
    createdBy: profile.userId,
    createdByName: profile.displayName,
    createdAt: now,
    updatedAt: now,
  };
  if (profile.pictureUrl) doc.createdByAvatar = profile.pictureUrl;

  const ref = await db.collection('restaurants').add(doc);
  return ref.id;
}

/**
 * 檢查同一個 Google Maps 連結是否已存在
 */
export async function findRestaurantByUrl(db, mapsUrl) {
  const snap = await db.collection('restaurants')
    .where('googleMapsUrl', '==', mapsUrl)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
