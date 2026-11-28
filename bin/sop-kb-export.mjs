#!/usr/bin/env node
/**
 * 把 vector-memory 的公司文件匯出成 sop plugin 用的知識庫（Windows 上跑）
 *
 *   node bin/sop-kb-export.mjs [--src <vector-memory.db>] [--out <sop-kb.db>]
 *
 * 只匯出 skill:rag、skill:km 兩個分類（寫死，不接受參數）。vector-memory 同一個檔裡還有
 * 個人記憶（global 等），絕不能進匯出檔。匯出後自我檢查，混進其他分類就刪檔、以非 0 結束。
 * 來源 DB 一律唯讀開啟。
 *
 * 另外印個資樣式掃描報告（只印段落 id 與類型，不印值），供人工確認要不要回頭補遮。
 */

import Database from 'better-sqlite3';
import { existsSync, rmSync, renameSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { KB_SCOPES, vecToBlob, parseHeader } from '../plugins/sop/retriever.js';
import { embedText, EMBED_MODEL } from '../plugins/sop/embed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SRC = 'C:/Ted/mcp-servers/vector-memory/vector-memory.db';
export const DEFAULT_OUT = resolve(ROOT, 'data/kb/sop-kb.db');
export const PROBE_TEXT = '請假要怎麼申請';

// 不給群組查的文件：config/sop-exclude.json（不進 git，各機器自己放），內容是文件名字串陣列，比對標題列、整份排除
export const EXCLUDE_PATH = resolve(ROOT, 'config/sop-exclude.json');
export function loadExcludeList(path = EXCLUDE_PATH) {
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !x.trim())) {
    throw new Error(`${path} 格式錯誤：要是文件名字串陣列`);
  }
  return list;
}
const isExcluded = (content, list) => {
  const title = parseHeader(content).title;
  return list.some(name => title.includes(name));
};

// ── 個資樣式掃描 ──────────────────────────────────────
const TW_ID_LETTER = 'ABCDEFGHJKLMNPQRSTUVXYWZIO';
function validTwId(id) {
  const n = TW_ID_LETTER.indexOf(id[0]) + 10;
  if (n < 10) return false;
  const d = [Math.floor(n / 10), n % 10, ...id.slice(1).split('').map(Number)];
  const w = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  return d.reduce((s, x, i) => s + x * w[i], 0) % 10 === 0;
}
export function scanPii(rows) {
  const found = [];
  for (const r of rows) {
    const t = r.content;
    const types = [];
    if (/09\d{2}[-\s]?\d{3}[-\s]?\d{3}/.test(t)) types.push('手機');
    if (/\(0\d{1,2}\)\s?\d{3,4}-?\d{4}|\b0\d{1,2}-\d{7,8}\b/.test(t)) types.push('市話');
    if ((t.match(/\b[A-Z][12]\d{8}\b/g) || []).some(validTwId)) types.push('身分證');
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) types.push('Email');
    if (types.length) found.push({ id: r.id, scope: r.scope, types });
  }
  return found;
}

/**
 * @returns {Promise<{ count: number, byScope: object, pii: Array, out: string }>}
 */
export async function exportKb({ src = DEFAULT_SRC, out = DEFAULT_OUT, embed = embedText, exclude = loadExcludeList() } = {}) {
  if (!existsSync(src)) throw new Error(`找不到來源資料庫：${src}`);
  const source = new Database(src, { readonly: true, fileMustExist: true });
  let rows;
  try {
    const marks = KB_SCOPES.map(() => '?').join(',');
    rows = source.prepare(
      `SELECT id, scope, content, embedding FROM memories
       WHERE scope IN (${marks}) AND embedding IS NOT NULL AND embed_model = ? ORDER BY id`
    ).all(...KB_SCOPES, EMBED_MODEL);
  } finally {
    source.close();
  }
  const before = rows.length;
  rows = rows.filter(r => !isExcluded(r.content, exclude));
  const excluded = before - rows.length;
  if (!rows.length) throw new Error('來源沒有可匯出的公司文件');

  const probeVec = Array.from(await embed(PROBE_TEXT));

  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.export-tmp`;
  rmSync(tmp, { force: true });
  const db = new Database(tmp);
  try {
    db.exec(`
      CREATE TABLE chunks (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, vec BLOB NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    const ins = db.prepare('INSERT INTO chunks (id, scope, content, vec) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      for (const r of rows) ins.run(r.id, r.scope, r.content, vecToBlob(JSON.parse(r.embedding)));
    })();
    const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    putMeta.run('exported_at', new Date().toISOString());
    putMeta.run('count', String(rows.length));
    putMeta.run('embed_model', EMBED_MODEL);
    putMeta.run('probe_text', PROBE_TEXT);
    putMeta.run('probe_vec', JSON.stringify(probeVec));
  } finally {
    db.close();
  }

  // 自我檢查：只能有白名單分類、筆數相符
  const check = new Database(tmp, { readonly: true });
  let scopes, count;
  try {
    scopes = check.prepare('SELECT scope, COUNT(*) AS n FROM chunks GROUP BY scope').all();
    count = check.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  } finally {
    check.close();
  }
  const bad = scopes.filter(s => !KB_SCOPES.includes(s.scope));
  if (bad.length || count !== rows.length) {
    rmSync(tmp, { force: true });
    throw new Error(`匯出檔自我檢查失敗（分類：${scopes.map(s => s.scope).join(',')}；筆數 ${count}/${rows.length}），已刪除`);
  }
  renameSync(tmp, out);

  return {
    count,
    excluded,
    byScope: Object.fromEntries(scopes.map(s => [s.scope, s.n])),
    pii: scanPii(rows),
    out,
  };
}

// ── CLI ─────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const res = await exportKb({ src: arg('--src') || DEFAULT_SRC, out: arg('--out') || DEFAULT_OUT });
    console.log(`匯出完成：${res.out}`);
    console.log(`共 ${res.count} 段：${Object.entries(res.byScope).map(([k, v]) => `${k} ${v}`).join('、')}；依 config/sop-exclude.json 排除 ${res.excluded} 段`);
    if (res.pii.length) {
      const byType = {};
      for (const p of res.pii) for (const t of p.types) (byType[t] ||= []).push(p.id);
      console.log('\n個資樣式掃描（只列段落 id，請人工確認）：');
      for (const [t, ids] of Object.entries(byType)) console.log(`  ${t} ${ids.length} 段：${ids.join(', ')}`);
    } else {
      console.log('個資樣式掃描：沒有發現');
    }
  } catch (err) {
    console.error(`匯出失敗：${err.message}`);
    process.exit(1);
  }
}
