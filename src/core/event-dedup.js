/**
 * Webhook 事件去重（2026-10-29）
 *
 * LINE 開了「Webhook 重送」：送失敗（例如 Cloudflare 通道短暫斷線）會用同一個 webhookEventId 再送。
 * 處理過的 ID 存 SQLite，bot 重開後也認得，重送的事件不會被處理兩次。
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';

export const KEEP_MS = 60 * 60_000; // 記一小時（比允許的重送延遲 30 分鐘長）

export function createEventDedup(dataDir, { keepMs = KEEP_MS } = {}) {
  const db = new Database(join(dataDir, '_webhook_seen.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  const hasStmt = db.prepare('SELECT 1 FROM seen WHERE id = ?');
  const addStmt = db.prepare('INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)');
  const purgeStmt = db.prepare('DELETE FROM seen WHERE at < ?');
  const timer = setInterval(() => purgeStmt.run(Date.now() - keepMs), 10 * 60_000);
  timer.unref?.();
  return {
    has: (id) => !!hasStmt.get(String(id)),
    add: (id, now = Date.now()) => { addStmt.run(String(id), now); },
    purge: (now = Date.now()) => purgeStmt.run(now - keepMs).changes,
    close: () => { clearInterval(timer); db.close(); },
  };
}

/** 沒有資料夾可用時（測試）的記憶體版 */
export function createMemoryDedup({ keepMs = KEEP_MS } = {}) {
  const seen = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - keepMs;
    for (const [id, at] of seen) if (at < cutoff) seen.delete(id);
  }, 60_000);
  timer.unref?.();
  return { has: (id) => seen.has(String(id)), add: (id, now = Date.now()) => { seen.set(String(id), now); } };
}
