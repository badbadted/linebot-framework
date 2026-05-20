/**
 * Database Provider
 *
 * 每個 Plugin 拿到獨立的 SQLite 資料庫（或共用同一個，以 table prefix 隔離）。
 * 提供兩種模式：
 *   - 'isolated': 每個 plugin 一個 .db 檔（預設）
 *   - 'shared':   所有 plugin 共用一個 .db，table 名自動加 plugin prefix
 *
 * Plugin 拿到的 db 物件：
 *   db.run(sql, ...params)       — 執行 INSERT/UPDATE/DELETE
 *   db.get(sql, ...params)       — 取一筆
 *   db.all(sql, ...params)       — 取多筆
 *   db.exec(sql)                 — 執行多條 SQL（建表用）
 *   db.prepare(sql)              — 取得 prepared statement
 *   db.transaction(fn)           — 交易
 *   db.close()                   — 關閉連線
 */

import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { mkdirSync } from 'fs';

export function createDatabaseProvider(dataDir, opts = {}) {
  const mode = opts.mode || 'isolated';
  const dbDir = resolve(dataDir);
  mkdirSync(dbDir, { recursive: true });

  const connections = new Map(); // pluginName → db instance

  /**
   * 取得 plugin 專屬的 db 連線
   * @param {string} pluginName
   * @returns {object} db wrapper
   */
  function getDatabase(pluginName) {
    if (connections.has(pluginName)) {
      return connections.get(pluginName);
    }

    let raw;
    let prefix = '';

    if (mode === 'shared') {
      // 共用模式：一個 db 檔，table 名加 prefix
      const dbPath = join(dbDir, 'shared.db');
      if (!connections.has('__shared__')) {
        raw = new Database(dbPath);
        raw.pragma('journal_mode = WAL');
        raw.pragma('foreign_keys = ON');
        connections.set('__shared__', raw);
      }
      raw = connections.get('__shared__');
      prefix = `${pluginName}_`;
    } else {
      // 隔離模式：每個 plugin 獨立 db 檔
      const dbPath = join(dbDir, `${pluginName}.db`);
      raw = new Database(dbPath);
      raw.pragma('journal_mode = WAL');
      raw.pragma('foreign_keys = ON');
    }

    // Wrapper — 隔離模式直接透傳，共用模式加 prefix
    const db = {
      run(sql, ...params) {
        return raw.prepare(prefixSQL(sql, prefix)).run(...params);
      },
      get(sql, ...params) {
        return raw.prepare(prefixSQL(sql, prefix)).get(...params);
      },
      all(sql, ...params) {
        return raw.prepare(prefixSQL(sql, prefix)).all(...params);
      },
      exec(sql) {
        return raw.exec(prefixSQL(sql, prefix));
      },
      prepare(sql) {
        return raw.prepare(prefixSQL(sql, prefix));
      },
      transaction(fn) {
        return raw.transaction(fn);
      },
      close() {
        if (mode !== 'shared') {
          raw.close();
          connections.delete(pluginName);
        }
      },
      /** 原始 better-sqlite3 實例（進階用途） */
      get raw() { return raw; },
    };

    connections.set(pluginName, db);
    console.log(`[database] ${pluginName}: ${mode === 'shared' ? 'shared (prefix: ' + prefix + ')' : join(dbDir, pluginName + '.db')}`);
    return db;
  }

  function closeAll() {
    const closed = new Set();
    for (const [name, conn] of connections) {
      const target = conn.raw || conn;
      if (!closed.has(target) && typeof target.close === 'function') {
        target.close();
        closed.add(target);
      }
    }
    connections.clear();
  }

  return { getDatabase, closeAll };
}

/**
 * 共用模式下，自動把 SQL 中的 table 名加 prefix。
 * 規則：CREATE TABLE / INSERT INTO / FROM / UPDATE / JOIN 後面的 table 名加 prefix。
 * 隔離模式下 prefix 為空字串，原樣返回。
 */
function prefixSQL(sql, prefix) {
  if (!prefix) return sql;
  // 簡易替換：只處理常見 SQL pattern
  return sql
    .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/gi,
      (_, ifne, name) => `CREATE TABLE ${ifne || ''}${prefix}${name}`)
    .replace(/INSERT\s+(OR\s+\w+\s+)?INTO\s+(\w+)/gi,
      (_, or, name) => `INSERT ${or || ''}INTO ${prefix}${name}`)
    .replace(/UPDATE\s+(\w+)\s+SET/gi,
      (_, name) => `UPDATE ${prefix}${name} SET`)
    .replace(/FROM\s+(\w+)/gi,
      (_, name) => `FROM ${prefix}${name}`)
    .replace(/JOIN\s+(\w+)/gi,
      (_, name) => `JOIN ${prefix}${name}`)
    .replace(/DELETE\s+FROM\s+(\w+)/gi,
      (_, name) => `DELETE FROM ${prefix}${name}`);
}
