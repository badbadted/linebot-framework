/**
 * Travel Plugin — 旅遊連結記錄
 *
 * 指令：
 *   /旅遊 <url>        → 記錄連結（自動抓網頁標題/描述）
 *   /旅遊             → 顯示已記錄清單
 *   /旅遊_del <編號>   → 刪除一筆
 *   /旅遊_all         → 顯示全部
 *
 * 儲存：SQLite travel_items（自含，方便日後遷移到新系統）
 * 需求 Provider：db（SQLite）
 */

import { flex } from '../../src/utils/flex.js';

let db;

const COLOR = '#0ea5e9'; // 天藍色，跟 work 的紫色區隔

// ── 格式化 ──────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

// ── 解析網頁標題 / 描述（OG meta，輕量、不依賴 Gemini） ──
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

/**
 * 判斷標題是否為爬蟲封鎖頁 / 無意義的垃圾標題。
 * 例：Error、純網域名、Cloudflare 擋頁、登入牆等。
 */
function isJunkTitle(title, url) {
  if (!title) return true;
  const t = title.trim().toLowerCase();
  const JUNK = [
    'error', 'errors', 'not found', '404', '403', 'forbidden',
    'just a moment...', 'just a moment', 'attention required! | cloudflare',
    'access denied', 'log in', 'log in to facebook', 'login',
    'facebook', 'instagram', 'redirecting...', 'loading...', 'page not found',
    'security check', '請稍候', '系統忙碌中',
  ];
  if (JUNK.includes(t)) return true;
  // 標題只是網域名（如 klook.com、tripadvisor.com.tw）
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (t === host || t === host.replace(/\.[a-z.]+$/, '')) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * 抓網頁的標題與描述。失敗回 {}（不擋記錄流程）。
 * @returns {{ title?: string, description?: string }}
 */
async function fetchMeta(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    });
    const html = await res.text();

    const rawTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]*)</i)?.[1]
      || '';
    const rawDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i)?.[1]
      || html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
      || '';

    const out = {};
    const title = decodeEntities(rawTitle);
    const desc = decodeEntities(rawDesc);
    if (title && !isJunkTitle(title, url)) out.title = title.slice(0, 120);
    if (desc) out.description = desc.slice(0, 300);
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// ── Plugin 定義 ──────────────────────────────────────
export default {
  name: 'travel',
  prefix: '旅遊',
  defaultCommand: 'list-travel',
  scope: 'all',

  commands: [
    // 記錄連結：/旅遊 <url>（傳統模式，非 prefix）
    {
      name: 'add-travel',
      pattern: /^\/旅遊\s+(.+)$/i,
      describe: '/旅遊 <連結> — 記錄旅遊連結',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';

        const input = match[1].trim();
        const urlMatch = input.match(/(https?:\/\/\S+)/i);
        if (!urlMatch) {
          return '請貼上連結\n範例：/旅遊 https://www.example.com/spot';
        }
        const url = urlMatch[1];

        // 重複檢查
        const exist = db.get(
          'SELECT id, title FROM travel_items WHERE user_id = ? AND url = ?',
          ctx.userId, url
        );
        if (exist) {
          return `這個連結已經記錄過了 🧳\n#${exist.id} ${exist.title || url}`;
        }

        // 嘗試解析標題/描述（失敗不擋記錄）
        const meta = await fetchMeta(url);

        const result = db.run(
          `INSERT INTO travel_items (user_id, url, title, description, created_at)
           VALUES (?, ?, ?, ?, datetime('now', '+8 hours'))`,
          ctx.userId, url, meta.title || '', meta.description || ''
        );
        const id = result.lastInsertRowid;

        const bodyLines = [];
        if (meta.title) bodyLines.push(`📌 ${meta.title}`);
        if (meta.description) bodyLines.push(`📝 ${meta.description}`);
        bodyLines.push(`🔗 ${url}`);
        if (!meta.title && !meta.description) {
          bodyLines.push('（無法解析標題，已存連結，日後可補）');
        }

        return flex.card({
          title: `🧳 已記錄旅遊 #${id}`,
          body: bodyLines.join('\n'),
          color: COLOR,
          actions: [
            { label: '開啟連結', uri: url },
            { label: '查看清單', text: '/旅遊' },
          ],
        });
      },
    },
    // 清單：裸 /旅遊
    {
      name: 'list-travel',
      command: 'list',
      describe: '/旅遊 — 顯示旅遊清單',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = db.all(
          `SELECT id, url, title, created_at FROM travel_items
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT 20`,
          ctx.userId
        );
        if (!items.length) return '🧳 還沒有旅遊記錄\n輸入 /旅遊 <連結> 新增第一筆';

        return flex.list('🧳 旅遊清單', items.map(t => ({
          label: `#${t.id}  ${t.title || t.url}`,
          value: formatDate(t.created_at),
        })), COLOR);
      },
    },
    // 刪除：/旅遊_del <編號>
    {
      name: 'del-travel',
      command: 'del',
      pattern: /^(\d+)$/,
      describe: '/旅遊_del <編號> — 刪除一筆',
      type: 'query',
      handler: async (match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const id = +match[1];
        const item = db.get(
          'SELECT * FROM travel_items WHERE id = ? AND user_id = ?',
          id, ctx.userId
        );
        if (!item) return `❌ 找不到 #${id}`;
        db.run('DELETE FROM travel_items WHERE id = ?', id);
        return `🗑️ 已刪除：#${id} ${item.title || item.url}`;
      },
    },
    // 全部：/旅遊_all（含連結與描述）
    {
      name: 'all-travel',
      command: 'all',
      describe: '/旅遊_all — 顯示全部（含連結）',
      type: 'query',
      handler: async (_match, ctx) => {
        if (!db) return '❌ 此 BOT 未啟用資料庫';
        const items = db.all(
          `SELECT id, url, title, description, created_at FROM travel_items
           WHERE user_id = ?
           ORDER BY id DESC
           LIMIT 20`,
          ctx.userId
        );
        if (!items.length) return '🧳 還沒有旅遊記錄';

        const lines = ['🧳 旅遊清單（全部）', ''];
        for (const t of items) {
          lines.push(`#${t.id}  ${t.title || '(無標題)'}`);
          lines.push(`🔗 ${t.url}`);
          lines.push('');
        }
        lines.push(`📊 共 ${items.length} 筆`);
        return lines.join('\n');
      },
    },
  ],

  schedules: [],

  init: async (ctx) => {
    db = ctx.db;
    if (!db) {
      console.warn('[travel] no db provider — travel storage disabled');
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS travel_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        description TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_travel_user ON travel_items (user_id, id)');
    console.log('[travel] ready');
  },
};
