/**
 * 妞揪 Firestore 連線 + 查詢模組
 *
 * Firebase Project: sipangzi003
 * Collections: events, participants, dateVotes, comments, users
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

  const events = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  // client 端排序，避免需要 Firestore 複合索引
  events.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return events.slice(0, limit);
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
