/**
 * Message Logger
 *
 * 輕量訊息記錄 — 所有 webhook 收到的訊息都記錄到 SQLite。
 * 不依賴 Provider Registry，框架啟動時直接初始化。
 *
 * 記錄欄位：
 *   timestamp, userId, sourceType, text, route, plugin, type,
 *   response（截斷）, duration_ms, error
 *
 * 查詢 API：
 *   /api/logs?limit=50&offset=0&userId=xxx&from=2026-05-20&to=2026-05-21&route=xxx
 *   /api/logs/stats?days=7
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { mkdirSync } from 'fs';
import { maskUserId } from './api-auth.js';

const MAX_RESPONSE_LENGTH = 500;  // response 截斷長度
const MAX_TEXT_LENGTH = 2000;     // text 截斷長度

export function createLogger(dataDir) {
  const dbDir = resolve(dataDir || './data');
  mkdirSync(dbDir, { recursive: true });

  const dbPath = resolve(dbDir, '_logs.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
      user_id    TEXT    NOT NULL,
      source_type TEXT   NOT NULL DEFAULT 'user',
      text       TEXT    NOT NULL,
      route      TEXT,
      plugin     TEXT,
      type       TEXT,
      response   TEXT,
      duration_ms INTEGER,
      error      TEXT
    )
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON message_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_user ON message_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_route ON message_logs(route);
  `);

  // ── 寫入 ──────────────────────────────────────────────

  const insertStmt = db.prepare(`
    INSERT INTO message_logs (timestamp, user_id, source_type, text, route, plugin, type, response, duration_ms, error)
    VALUES (datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * 記錄一筆訊息
   * @param {object} entry
   */
  function log(entry) {
    try {
      insertStmt.run(
        entry.userId || '',
        entry.sourceType || 'user',
        (entry.text || '').slice(0, MAX_TEXT_LENGTH),
        entry.route || null,
        entry.plugin || null,
        entry.type || null,
        entry.response ? entry.response.slice(0, MAX_RESPONSE_LENGTH) : null,
        entry.durationMs ?? null,
        entry.error || null,
      );
    } catch (err) {
      console.error(`[logger] write error: ${err.message}`);
    }
  }

  // ── 查詢 ──────────────────────────────────────────────

  /**
   * 查詢訊息記錄
   * @param {object} opts - { limit, offset, userId, from, to, route }
   */
  function query(opts = {}) {
    const limit = Math.min(opts.limit || 50, 500);
    const offset = opts.offset || 0;

    let where = [];
    let params = [];

    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.from) {
      where.push('timestamp >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('timestamp <= ?');
      params.push(opts.to + ' 23:59:59');
    }
    if (opts.route) {
      where.push('route = ?');
      params.push(opts.route);
    }
    if (opts.hasError) {
      where.push('error IS NOT NULL');
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT * FROM message_logs ${whereClause}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const countRow = db.prepare(`
      SELECT COUNT(*) as total FROM message_logs ${whereClause}
    `).get(...params);

    return { logs: rows, total: countRow.total, limit, offset };
  }

  /**
   * 統計（最近 N 天）
   * @param {number} days
   */
  function stats(days = 7) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    // 每日訊息數
    const daily = db.prepare(`
      SELECT date(timestamp) as date, COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= ?
      GROUP BY date(timestamp)
      ORDER BY date
    `).all(sinceStr);

    // 指令排行
    const topRoutes = db.prepare(`
      SELECT route, COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= ? AND route IS NOT NULL
      GROUP BY route
      ORDER BY count DESC
      LIMIT 10
    `).all(sinceStr);

    // 活躍使用者
    const topUsers = db.prepare(`
      SELECT user_id, COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= ?
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10
    `).all(sinceStr);

    // 錯誤數
    const errorCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= ? AND error IS NOT NULL
    `).get(sinceStr);

    // 總筆數
    const totalCount = db.prepare(`
      SELECT COUNT(*) as count FROM message_logs WHERE timestamp >= ?
    `).get(sinceStr);

    // 未匹配數
    const unmatchedCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= ? AND route = 'unmatched'
    `).get(sinceStr);

    return {
      period: { days, since: sinceStr },
      total: totalCount.count,
      errors: errorCount.count,
      unmatched: unmatchedCount.count,
      daily,
      topRoutes,
      topUsers,
    };
  }

  // ── Express 路由 ───────────────────────────────────────

  /**
   * 註冊 /api/logs 和 /api/logs/stats 路由
   */
  function registerRoutes(app) {
    app.get('/api/logs', (req, res) => {
      const result = query({
        limit: parseInt(req.query.limit) || 50,
        offset: parseInt(req.query.offset) || 0,
        userId: req.query.userId || req.query.user_id,
        from: req.query.from,
        to: req.query.to,
        route: req.query.route,
        hasError: req.query.errors === 'true',
      });
      // 遮蔽 PII：userId 只顯示前 8 碼
      result.logs = result.logs.map(row => ({
        ...row,
        user_id: maskUserId(row.user_id),
      }));
      res.json(result);
    });

    app.get('/api/logs/stats', (req, res) => {
      const days = parseInt(req.query.days) || 7;
      const result = stats(days);
      // 遮蔽 topUsers 的 userId
      result.topUsers = result.topUsers.map(u => ({
        ...u,
        user_id: maskUserId(u.user_id),
      }));
      res.json(result);
    });
  }

  function close() {
    try { db.close(); } catch {}
  }

  return { log, query, stats, registerRoutes, close };
}
