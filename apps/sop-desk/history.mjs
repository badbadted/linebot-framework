/**
 * 查詢歷史（自用，存在 data/sop-desk/history.db，data/ 不進 git）
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export function openHistory(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      question TEXT NOT NULL,
      mode TEXT NOT NULL,          -- answer | raw
      status TEXT NOT NULL,        -- answered | not_found | raw | error
      answer TEXT,                 -- 答案正文（不含出處）
      sources TEXT,                -- JSON：出處清單
      hits TEXT,                   -- JSON：右欄段落
      top_cosine REAL,
      duration_ms INTEGER,
      error TEXT
    )
  `);

  return {
    add(row) {
      const r = db.prepare(
        `INSERT INTO history (question, mode, status, answer, sources, hits, top_cosine, duration_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.question, row.mode, row.status, row.answer ?? null, JSON.stringify(row.sources ?? []),
        JSON.stringify(row.hits ?? []), row.topCosine ?? null, row.durationMs ?? null, row.error ?? null);
      return Number(r.lastInsertRowid);
    },
    list(limit = 200) {
      return db.prepare('SELECT id, created_at, question, status FROM history ORDER BY id DESC LIMIT ?').all(limit);
    },
    get(id) {
      const r = db.prepare('SELECT * FROM history WHERE id = ?').get(id);
      if (!r) return null;
      return { ...r, sources: JSON.parse(r.sources || '[]'), hits: JSON.parse(r.hits || '[]') };
    },
    remove(id) {
      return db.prepare('DELETE FROM history WHERE id = ?').run(id).changes > 0;
    },
    close() { db.close(); },
  };
}
