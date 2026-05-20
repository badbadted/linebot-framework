/**
 * SQLite Provider (better-sqlite3)
 *
 * Config:
 *   { type: 'sqlite', dir: './data', mode: 'isolated' | 'shared' }
 *
 * 回傳的 instance 提供 getDatabase(pluginName) 方法，
 * 每個 plugin 拿到獨立或共用的 db 連線。
 */

import Database from 'better-sqlite3';
import { resolve, join } from 'path';
import { mkdirSync } from 'fs';

export async function createSQLiteProvider(config) {
  const mode = config.mode || 'isolated';
  const dbDir = resolve(config.dir || './data');
  mkdirSync(dbDir, { recursive: true });

  const connections = new Map();

  function getDatabase(pluginName) {
    if (connections.has(pluginName)) return connections.get(pluginName);

    let raw;
    let prefix = '';

    if (mode === 'shared') {
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
      const dbPath = join(dbDir, `${pluginName}.db`);
      raw = new Database(dbPath);
      raw.pragma('journal_mode = WAL');
      raw.pragma('foreign_keys = ON');
    }

    const db = {
      run(sql, ...params) { return raw.prepare(prefixSQL(sql, prefix)).run(...params); },
      get(sql, ...params) { return raw.prepare(prefixSQL(sql, prefix)).get(...params); },
      all(sql, ...params) { return raw.prepare(prefixSQL(sql, prefix)).all(...params); },
      exec(sql) { return raw.exec(prefixSQL(sql, prefix)); },
      prepare(sql) { return raw.prepare(prefixSQL(sql, prefix)); },
      transaction(fn) { return raw.transaction(fn); },
      close() { if (mode !== 'shared') { raw.close(); connections.delete(pluginName); } },
      get raw() { return raw; },
    };

    connections.set(pluginName, db);
    return db;
  }

  function close() {
    const closed = new Set();
    for (const conn of connections.values()) {
      const target = conn.raw || conn;
      if (!closed.has(target) && typeof target.close === 'function') {
        target.close();
        closed.add(target);
      }
    }
    connections.clear();
  }

  return { getDatabase, close };
}

function prefixSQL(sql, prefix) {
  if (!prefix) return sql;
  return sql
    .replace(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(\w+)/gi, (_, ifne, name) => `CREATE TABLE ${ifne || ''}${prefix}${name}`)
    .replace(/INSERT\s+(OR\s+\w+\s+)?INTO\s+(\w+)/gi, (_, or, name) => `INSERT ${or || ''}INTO ${prefix}${name}`)
    .replace(/UPDATE\s+(\w+)\s+SET/gi, (_, name) => `UPDATE ${prefix}${name} SET`)
    .replace(/FROM\s+(\w+)/gi, (_, name) => `FROM ${prefix}${name}`)
    .replace(/JOIN\s+(\w+)/gi, (_, name) => `JOIN ${prefix}${name}`)
    .replace(/DELETE\s+FROM\s+(\w+)/gi, (_, name) => `DELETE FROM ${prefix}${name}`);
}
