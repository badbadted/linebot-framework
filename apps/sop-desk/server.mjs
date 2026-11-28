#!/usr/bin/env node
/**
 * 公司文件查詢（自用本機 App）伺服器
 *
 *   node apps/sop-desk/server.mjs        → http://127.0.0.1:4790/
 *
 * 只綁 127.0.0.1；知識庫用跟 LINE /sop 同一份 data/kb/sop-kb.db；回答用本機 claude -p（訂閱）。
 * 閒置 30 分鐘自動結束（桌面捷徑會再叫起來）。
 */

import http from 'http';
import { readFile } from 'fs/promises';
import { resolve, dirname, extname, join, normalize as normPath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRetriever } from '../../plugins/sop/retriever.js';
import { embedText, OLLAMA_URL } from '../../plugins/sop/embed.js';
import { answer as runAnswer } from '../../plugins/sop/answer.js';
import { createClaudeCli } from './claude-cli.mjs';
import { checkRequest, createRateLimit } from './guard.mjs';
import { openHistory } from './history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
export const PORT = Number(process.env.SOP_DESK_PORT || 4790);
const PUBLIC = join(HERE, 'public');
const IDLE_MS = 30 * 60 * 1000;
const Q_MIN = 4;
const Q_MAX = 500;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// ── 資料轉換 ──────────────────────────────────────────
const docKey = h => `${h.header.docName}|${h.header.version}`;

/** 段落轉成給前端的格式；docN = 送給模型時的文件編號（同 answer.js groupByDoc 的順序） */
export function hitsToDto(hits) {
  const order = new Map();
  return hits.map(h => {
    if (!order.has(docKey(h))) order.set(docKey(h), order.size + 1);
    return {
      id: h.id, docN: order.get(docKey(h)), title: h.header.title, version: h.header.version, date: h.header.date,
      category: h.header.category, isIndex: h.header.isIndex, cosine: Number(h.cosine.toFixed(3)), content: h.content,
    };
  });
}

/** answer.js 的 LINE 版格式拆成正文＋出處清單（出處對到右欄段落 id） */
export function splitAnswer(text, cited, dtoHits) {
  let body = String(text || '').replace(/^文件問答\n/, '');
  const cut = body.indexOf('\n\n出處\n');
  if (cut >= 0) body = body.slice(0, cut);
  const sources = (cited || []).map((docN, i) => {
    const hs = dtoHits.filter(h => h.docN === docN);
    return { n: i + 1, docN, title: hs[0]?.title || '', version: hs[0]?.version || '', date: hs[0]?.date || '', hitIds: hs.map(h => h.id) };
  });
  return { body: body.trim(), sources };
}

function validQuestion(q) {
  const s = String(q || '').trim();
  if (s.length < Q_MIN || s.length > Q_MAX) return { error: `問題請寫 ${Q_MIN}～${Q_MAX} 字` };
  return { q: s };
}

// ── App ───────────────────────────────────────────────
/**
 * @param {{ retriever, llm, history, port?: number, model?: string, ollamaUrl?: string, perMinute?: number, onActivity?: Function }} deps
 */
export function createApp({ retriever, llm, history, port = PORT, ollamaUrl = OLLAMA_URL, perMinute = 6, onActivity = () => {} }) {
  const allow = createRateLimit(perMinute);
  let busy = false;

  async function ollamaUp() {
    try {
      const r = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  async function search(q) {
    const found = await retriever.search(q);
    if (found.status === 'disabled') throw new Error(`知識庫停用：${found.reason}`);
    return found;
  }

  const routes = {
    'GET /api/health': async () => {
      retriever.maybeReload();
      const meta = retriever.meta;
      return {
        kb: { count: retriever.size, exportedAt: meta.exported_at || null, disabled: retriever.disabledReason || null },
        ollama: await ollamaUp(),
        claude: { ...(llm.status ? await llm.status() : { available: true, loggedIn: true }), model: llm.model || null },
      };
    },

    'POST /api/search': async body => {
      const v = validQuestion(body.q);
      if (v.error) return [400, { error: v.error }];
      const t0 = Date.now();
      const found = await search(v.q);
      return {
        status: found.status, topCosine: found.topCosine, ms: Date.now() - t0,
        hits: found.status === 'ok' ? hitsToDto(found.hits) : [],
        nearest: found.status === 'not_found' ? hitsToDto(found.nearest || []) : [],
      };
    },

    'POST /api/answer': async body => {
      const v = validQuestion(body.q);
      if (v.error) return [400, { error: v.error }];
      const raw = body.raw === true;
      if (!raw && busy) return [409, { error: '還有一題在整理中，等它完成再問' }];
      if (!raw && !allow()) return [429, { error: '一分鐘內問太多題，稍等一下' }];

      const t0 = Date.now();
      const found = await search(v.q);
      const hits = found.status === 'ok' ? hitsToDto(found.hits) : [];
      const base = { question: v.q, mode: raw ? 'raw' : 'answer', topCosine: found.topCosine };

      if (found.status === 'not_found') {
        const nearest = hitsToDto(found.nearest || []);
        const id = history.add({ ...base, status: 'not_found', hits: nearest, durationMs: Date.now() - t0 });
        return { id, status: 'not_found', topCosine: found.topCosine, hits: [], nearest };
      }
      if (raw) {
        const id = history.add({ ...base, status: 'raw', hits, durationMs: Date.now() - t0 });
        return { id, status: 'raw', topCosine: found.topCosine, hits };
      }

      busy = true;
      try {
        const ans = await runAnswer({ question: v.q, hits: found.hits, llm, model: llm.model || 'haiku', maxTokens: 1500, timeoutMs: 60000 });
        const durationMs = Date.now() - t0;
        if (ans.status === 'not_found') {
          const id = history.add({ ...base, status: 'not_found', hits, durationMs });
          return { id, status: 'not_found', reason: 'model', topCosine: found.topCosine, hits, nearest: [] };
        }
        const { body: text, sources } = splitAnswer(ans.text, ans.cited, hits);
        const id = history.add({ ...base, status: 'answered', answer: text, sources, hits, durationMs });
        return { id, status: 'answered', answer: text, sources, hits, topCosine: found.topCosine, durationMs };
      } catch (err) {
        const timeout = err.code === 'TIMEOUT';
        const id = history.add({ ...base, status: 'error', hits, durationMs: Date.now() - t0, error: err.message });
        return { id, status: 'error', errorKind: timeout ? 'timeout' : 'claude', error: err.message, hits, topCosine: found.topCosine };
      } finally {
        busy = false;
      }
    },

    'GET /api/history': async () => ({ items: history.list() }),
  };

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }

  async function serveStatic(req, res) {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = normPath(join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    try {
      const data = await readFile(file);
      send(res, 200, data, TYPES[extname(file)] || 'application/octet-stream');
    } catch {
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }
  }

  return async function handler(req, res) {
    onActivity();
    const blocked = checkRequest(req, port);
    if (blocked) return send(res, 403, { error: 'forbidden' });

    const url = (req.url || '/').split('?')[0];
    const method = (req.method || 'GET').toUpperCase();
    try {
      if (url.startsWith('/api/')) {
        let m;
        if (method === 'GET' && (m = /^\/api\/history\/(\d+)$/.exec(url))) {
          const item = history.get(Number(m[1]));
          return item ? send(res, 200, item) : send(res, 404, { error: '找不到這筆紀錄' });
        }
        if (method === 'DELETE' && (m = /^\/api\/history\/(\d+)$/.exec(url))) {
          return send(res, 200, { ok: history.remove(Number(m[1])) });
        }
        const route = routes[`${method} ${url}`];
        if (!route) return send(res, 404, { error: 'not found' });
        const body = method === 'POST' ? await readJson(req) : {};
        const out = await route(body);
        return Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out);
      }
      if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(`[sop-desk] ${err.message}`);
      return send(res, status, { error: status === 500 ? err.message : 'bad request' });
    }
  };
}

// ── 直接執行 ──────────────────────────────────────────
async function main() {
  const retriever = createRetriever({ dbPath: resolve(ROOT, 'data/kb/sop-kb.db'), embed: embedText, minCosine: 0.62 });
  retriever.load();
  const llm = createClaudeCli({ model: process.env.SOP_DESK_MODEL || 'haiku' });
  const history = openHistory(resolve(ROOT, 'data/sop-desk/history.db'));

  let last = Date.now();
  const handler = createApp({ retriever, llm, history, onActivity: () => { last = Date.now(); } });
  const server = http.createServer(handler);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.log(`[sop-desk] ${PORT} 已經有程式在跑，不重複啟動`); process.exit(0); }
    console.error(err);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[sop-desk] http://127.0.0.1:${PORT}/  知識庫 ${retriever.size} 段${retriever.disabledReason ? `（${retriever.disabledReason}）` : ''}`);
  });
  setInterval(() => {
    if (Date.now() - last > IDLE_MS) {
      console.log('[sop-desk] 閒置 30 分鐘，結束');
      history.close();
      process.exit(0);
    }
  }, 60_000).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
