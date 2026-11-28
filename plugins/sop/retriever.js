/**
 * 公司文件檢索（只讀 sop-kb.db，這個檔只含 skill:rag、skill:km 兩個分類，由 bin/sop-kb-export.mjs 產生）
 *
 * 不連 vector-memory、不連小帥的記憶：那邊的搜尋查 skill 分類時會一併撈個人記憶（index.mjs:135）。
 *
 * 計分：0.8 × 向量（以中位數為零點正規化）＋ 0.2 × 關鍵字（中文二字詞，照 vector-memory index.mjs keywordTokens）
 * 「找不到」用原始餘弦判：全庫最高餘弦低於 minCosine 就不送模型。
 */

import Database from 'better-sqlite3';
import { statSync, existsSync } from 'fs';

export const KB_SCOPES = ['skill:rag', 'skill:km'];

// ── 向量工具 ──────────────────────────────────────────
export function normalize(vec) {
  const v = Float32Array.from(vec);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
export function dot(a, b) {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}
export function blobToVec(buf) {
  // better-sqlite3 給 Buffer；複製一份確保 4 bytes 對齊
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}
export function vecToBlob(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

// ── 關鍵字（照 C:/Ted/mcp-servers/vector-memory/index.mjs keywordTokens） ──
export function keywordTokens(query) {
  const toks = new Set();
  for (const m of (query || '').toLowerCase().match(/[a-z0-9_.\-]+|[\u3400-\u9fff]+/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(m)) {
      if (m.length === 1) toks.add(m);
      else for (let i = 0; i < m.length - 1; i++) toks.add(m.slice(i, i + 2));
    } else if (m.length > 1) {
      toks.add(m);
    }
  }
  return [...toks];
}

// ── 標題列解析 ────────────────────────────────────────
// 第一行：【<民國日期7碼><部門>-<文件名>V<版次>】(<分類>)
// 檔名內可能有巢狀【】（如【系】），所以用貪婪比對到最後一個「】(」
const HEADER_RE = /^【(.+)】[（(]([^\n]*)[)）]\s*$/;

export function parseHeader(content) {
  const first = String(content || '').split('\n', 1)[0].trim();
  const m = HEADER_RE.exec(first);
  if (!m) return { title: first.slice(0, 60) || '（未命名文件）', docName: first.slice(0, 60), version: '', date: '', category: '', isIndex: false };
  let name = m[1].trim();
  const category = m[2].trim();
  let date = '';
  const dm = /^(\d{3})(\d{2})(\d{2})/.exec(name);
  if (dm) {
    date = `${dm[1]}/${dm[2]}/${dm[3]}`;
    name = name.slice(7);
  }
  let version = '';
  const vm = /V(\d+(?:\.\d+)?)$/i.exec(name);
  if (vm) {
    version = `V${vm[1]}`;
    name = name.slice(0, vm.index).trim();
  }
  return {
    title: name,
    docName: name, // 同一份文件的鍵（不含版次）
    version,
    date,
    category,
    isIndex: /｜索引/.test(category),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath        sop-kb.db 路徑
 * @param {(text:string)=>Promise<Float32Array|number[]>} opts.embed  問題轉向量
 * @param {number} [opts.minCosine=0.6]
 * @param {number} [opts.topK=6]
 * @param {number} [opts.perDoc=3]    同一份文件最多幾段
 * @param {number} [opts.hitFloor]     每一段自己的最低餘弦（預設 minCosine-0.05），太不像的段落不送進 prompt
 */
export function createRetriever({ dbPath, embed, minCosine = 0.6, topK = 6, perDoc = 3, hitFloor = minCosine - 0.05 }) {
  let chunks = [];      // { id, scope, content, vec, header }
  let meta = {};
  let loadedMtime = 0;
  let disabledReason = '';

  function load() {
    if (!existsSync(dbPath)) {
      chunks = [];
      meta = {};
      disabledReason = `找不到知識庫檔 ${dbPath}`;
      return false;
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id, scope, content, vec FROM chunks').all();
      const bad = rows.filter(r => !KB_SCOPES.includes(r.scope));
      if (bad.length) {
        // 匯出檔不該有其他分類；有就整個不用，寧可停用也不冒險
        chunks = [];
        disabledReason = `知識庫含不允許的分類（${[...new Set(bad.map(r => r.scope))].join(', ')}），已停用`;
        return false;
      }
      chunks = rows.map(r => ({
        id: r.id,
        scope: r.scope,
        content: r.content,
        vec: normalize(blobToVec(r.vec)),
        header: parseHeader(r.content),
      }));
      meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value]));
      loadedMtime = statSync(dbPath).mtimeMs;
      disabledReason = '';
      return true;
    } finally {
      db.close();
    }
  }

  /** 檔案換了（同步腳本原子替換）就重載 */
  function maybeReload() {
    try {
      const m = existsSync(dbPath) ? statSync(dbPath).mtimeMs : 0;
      if (m !== loadedMtime) load();
    } catch (err) {
      disabledReason = `讀知識庫失敗：${err.message}`;
    }
  }

  /**
   * 探針句自檢：本機 Ollama 算出來的向量要跟匯出時存的一致（>0.99），防兩台模型不同
   * @returns {Promise<{ ok: boolean, cosine?: number, reason?: string }>}
   */
  async function selfCheck() {
    if (!chunks.length) return { ok: false, reason: disabledReason || '知識庫是空的' };
    if (!meta.probe_text || !meta.probe_vec) return { ok: false, reason: '知識庫缺探針資料' };
    let probe;
    try {
      probe = normalize(JSON.parse(meta.probe_vec));
    } catch {
      return { ok: false, reason: '探針向量格式錯誤' };
    }
    const now = normalize(await embed(meta.probe_text));
    const cosine = dot(probe, now);
    return cosine > 0.99 ? { ok: true, cosine } : { ok: false, cosine, reason: `向量模型跟匯出時不一致（探針相似度 ${cosine.toFixed(4)}）` };
  }

  /**
   * @returns {Promise<{ status: 'ok'|'not_found'|'disabled', hits?: Array, topCosine?: number, reason?: string }>}
   */
  async function search(query) {
    maybeReload();
    if (!chunks.length) return { status: 'disabled', reason: disabledReason || '知識庫是空的' };

    const q = normalize(await embed(query));
    const cos = chunks.map(c => dot(q, c.vec));
    const topCosine = Math.max(...cos);
    if (!(topCosine >= minCosine)) {
      // 找不到時附上最接近的 3 段（不同文件），給自用 App 顯示「可能相關但不足以回答」；LINE 版不用
      const seen = new Set();
      const nearest = chunks
        .map((c, i) => ({ c, cosine: cos[i] }))
        .sort((a, b) => b.cosine - a.cosine)
        .filter(({ c }) => !seen.has(c.header.docName) && seen.add(c.header.docName))
        .slice(0, 3)
        .map(({ c, cosine }) => ({ id: c.id, scope: c.scope, content: c.content, header: c.header, cosine }));
      return { status: 'not_found', topCosine, nearest };
    }

    // 向量：中位數為零點正規化（bge-m3 不相關內容也有 0.4～0.5）
    const sorted = [...cos].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const spread = topCosine - med;
    const vecNorm = v => (spread > 1e-6 ? Math.max(0, (v - med) / spread) : 1);

    const tokens = keywordTokens(query);
    const kw = chunks.map(c => {
      if (!tokens.length) return 0;
      const t = c.content.toLowerCase();
      return tokens.filter(k => t.includes(k)).length / tokens.length;
    });
    const maxKw = Math.max(...kw, 1e-9);

    const ranked = chunks
      .map((c, i) => ({ c, cosine: cos[i], score: 0.8 * vecNorm(cos[i]) + 0.2 * (kw[i] / maxKw) }))
      .sort((a, b) => b.score - a.score);

    const perDocCount = new Map();
    const hits = [];
    for (const r of ranked) {
      if (hits.length >= topK) break;
      if (r.cosine < hitFloor) continue;
      const key = r.c.header.docName;
      const n = perDocCount.get(key) || 0;
      if (n >= perDoc) continue;
      perDocCount.set(key, n + 1);
      hits.push({ id: r.c.id, scope: r.c.scope, content: r.c.content, header: r.c.header, cosine: r.cosine, score: r.score });
    }
    return { status: 'ok', hits, topCosine };
  }

  return {
    load,
    maybeReload,
    selfCheck,
    search,
    get size() { return chunks.length; },
    get meta() { return { ...meta }; },
    get disabledReason() { return disabledReason; },
  };
}
