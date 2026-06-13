/**
 * linebot-framework — 主入口
 *
 * 啟動流程：
 * 1. 讀取設定
 * 2. 初始化 Provider Registry（DB、LLM、Cache 等外接服務）
 * 3. 初始化核心模組（router, scheduler, line-api）
 * 4. 載入 plugins（傳入 providers）
 * 5. 啟動 Express server
 */

import express from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRouter } from './core/router.js';
import { createLineAPI } from './core/line-api.js';
import { createScheduler } from './core/scheduler.js';
import { createWebhookHandler } from './core/webhook.js';
import { loadPlugins } from './core/plugin-loader.js';
import { createProviderRegistry } from './core/provider-registry.js';
import { registerBuiltinProviders } from './providers/index.js';
import { createLogger } from './core/logger.js';
import { createApiAuth } from './core/api-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 讀取設定 ──────────────────────────────────────────
function loadConfig() {
  const configPath = resolve(ROOT, process.env.CONFIG || 'config/default.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  // 環境變數覆蓋（優先）
  return {
    line: {
      channelSecret: process.env.LINE_CHANNEL_SECRET || config.line?.channelSecret || '',
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || config.line?.channelAccessToken || '',
    },
    server: {
      port: parseInt(process.env.PORT || config.server?.port || 3100, 10),
      webhookPath: config.server?.webhookPath || '/line/webhook',
    },
    plugins: {
      dir: resolve(ROOT, config.plugins?.dir || './plugins'),
      enabled: config.plugins?.enabled || [],
    },
    scheduler: {
      httpTrigger: config.scheduler?.httpTrigger !== false,
      httpPath: config.scheduler?.httpPath || '/api/cron',
    },
    providers: config.providers || {},
    apiAuth: config.server?.apiAuth || {},
  };
}

function loadGroupPermissions() {
  const groupsPath = resolve(ROOT, 'config/groups.json');
  try {
    const raw = JSON.parse(readFileSync(groupsPath, 'utf-8'));
    // 過濾掉 _doc, _example 等說明欄位
    const perms = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('_') && Array.isArray(v)) perms[k] = v;
    }
    return perms;
  } catch {
    return {};
  }
}

// ── 主程式 ────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  // 初始化 Provider Registry
  const registry = createProviderRegistry();
  registerBuiltinProviders(registry);

  // 解析 providers config 中的相對路徑
  if (config.providers.db?.dir) {
    config.providers.db.dir = resolve(ROOT, config.providers.db.dir);
  }

  await registry.initFromConfig(config.providers);

  // 初始化核心
  const lineApi = createLineAPI(config.line.channelAccessToken);
  const router = createRouter();
  const scheduler = createScheduler({ lineApi });

  // 群組權限：從 config/groups.json 載入，預設全關
  const groupPerms = loadGroupPermissions();
  if (Object.keys(groupPerms).length > 0) {
    router.setGroupPermissions(groupPerms);
  }
  const dataDir = config.providers.db?.dir || resolve(ROOT, './data');
  const logger = createLogger(dataDir);

  // 載入 plugins（傳入所有 providers）
  const loaded = await loadPlugins(config.plugins.dir, {
    router,
    scheduler,
    lineApi,
    providers: registry,
    enabledList: config.plugins.enabled,
  });

  // Express
  const app = express();

  // rawBody 保留（LINE 簽章驗證需要）
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // Dashboard 靜態頁面（/public/dashboard.html）
  app.use('/public', express.static(resolve(ROOT, 'public')));
  app.get('/dashboard', (_req, res) => res.redirect('/public/dashboard.html'));

  // API 驗證：保護 /api/* 管理端點（webhook 路徑不受限）
  const apiAuth = createApiAuth(config.apiAuth);
  app.use('/api', apiAuth);

  // 系統指令：/groupid — 回覆當前群組 ID（方便加白名單）
  router.add(/^\/groupid$/i, async (_match, ctx) => {
    if (ctx.groupId) {
      return `群組 ID：\n${ctx.groupId}\n\n請將此 ID 加入 config/groups.json`;
    }
    return `這是私訊，沒有群組 ID。\n你的 userId：${ctx.userId}`;
  }, {
    type: 'query',
    name: 'groupid',
    plugin: '_system',
    describe: '/groupid — 查詢群組 ID',
    scope: 'all',
  });

  // 系統指令：/radar — 即時雷達回波圖（中央氣象署）
  router.add(/^\/雷達$/i, async (_match, _ctx) => {
    // 加 timestamp 避免 LINE 快取舊圖
    const ts = Date.now();
    const radarUrl = `https://www.cwa.gov.tw/Data/radar/CV1_TW_3600.png?t=${ts}`;
    return {
      type: 'image',
      originalContentUrl: radarUrl,
      previewImageUrl: radarUrl,
    };
  }, {
    type: 'query',
    name: 'radar',
    plugin: '_system',
    describe: '/雷達 — 即時雷達回波圖',
    scope: 'all',
  });

  // ── 管理員權限（config/admin.json）+ 群組開通指令 ──────
  const adminPath = resolve(ROOT, 'config/admin.json');
  function loadAdmins() {
    try {
      const raw = JSON.parse(readFileSync(adminPath, 'utf-8'));
      return Array.isArray(raw.adminUserIds) ? raw.adminUserIds : [];
    } catch { return []; }
  }
  let adminUserIds = loadAdmins();
  const isAdmin = (uid) => adminUserIds.includes(uid);

  // 可開通的功能：已載入的 plugin + 虛擬 _llm 對話權限
  const openablePlugins = new Set([...loaded, '_llm']);

  // 把某群組權限寫回 config/groups.json（保留 _name/_doc 等說明欄位）
  const groupsPath = resolve(ROOT, 'config/groups.json');
  function persistGroupPerms(groupId, plugins) {
    let raw = {};
    try { raw = JSON.parse(readFileSync(groupsPath, 'utf-8')); } catch { /* 新檔 */ }
    raw[groupId] = plugins;
    writeFileSync(groupsPath, JSON.stringify(raw, null, 2) + '\n');
  }

  // /設為管理員 — 首次認領（限私訊、限尚無管理員）
  router.add(/^\/設為管理員$/i, async (_match, ctx) => {
    if (ctx.groupId) return '請私訊我使用此指令';
    if (adminUserIds.length > 0) {
      return isAdmin(ctx.userId) ? '你已經是管理員了 ✅' : '管理員已設定，無法重複認領';
    }
    adminUserIds = [ctx.userId];
    writeFileSync(adminPath, JSON.stringify({ adminUserIds }, null, 2) + '\n');
    console.log(`[admin] claimed by ${ctx.userId}`);
    return '✅ 你已成為管理員\n之後可在任何群組打 /開通 <功能> 開放使用';
  }, { type: 'query', name: 'claim-admin', plugin: '_system', scope: 'all' });

  // /權限 — 查看當前群組已開放的功能
  router.add(/^\/權限$/i, async (_match, ctx) => {
    if (!ctx.groupId) return '私訊不受限，所有功能都能用';
    const cur = groupPerms[ctx.groupId] || [];
    if (!cur.length) return '本群尚未開放任何功能\n管理員可用 /開通 <功能> 開放';
    return `本群已開放：\n${cur.join('、')}`;
  }, { type: 'query', name: 'list-perms', plugin: '_system', describe: '/權限 — 查看本群開放的功能', scope: 'all' });

  // /開通 <功能...> — 管理員在群組開放功能（即時生效 + 寫回 groups.json）
  router.add(/^\/開通\s*(.+)$/i, async (match, ctx) => {
    if (!ctx.groupId) return '請在要開通的群組裡使用此指令';
    if (!isAdmin(ctx.userId)) {
      console.log(`[admin] /開通 denied for ${ctx.userId}`);
      return adminUserIds.length === 0
        ? '⛔ 尚未設定管理員\n請先私訊我打 /設為管理員 認領'
        : '⛔ 僅管理員可用';
    }
    const want = match[1].trim().toLowerCase().split(/\s+/);
    const valid = want.filter(p => openablePlugins.has(p));
    const invalid = want.filter(p => !openablePlugins.has(p));
    if (!valid.length) return `沒有可開通的功能\n可用：${[...openablePlugins].join('、')}`;
    const cur = new Set(groupPerms[ctx.groupId] || []);
    valid.forEach(p => cur.add(p));
    groupPerms[ctx.groupId] = [...cur];
    router.setGroupPermissions(groupPerms);
    persistGroupPerms(ctx.groupId, groupPerms[ctx.groupId]);
    const lines = [`✅ 已開通：${valid.join('、')}`];
    if (invalid.length) lines.push(`⚠️ 略過未知功能：${invalid.join('、')}`);
    lines.push(`本群現可用：${groupPerms[ctx.groupId].join('、')}`);
    return lines.join('\n');
  }, { type: 'query', name: 'open-plugin', plugin: '_system', describe: '/開通 <功能> — （管理員）開放功能到本群', scope: 'all' });

  // /關閉 <功能...> — 管理員移除群組功能
  router.add(/^\/關閉\s*(.+)$/i, async (match, ctx) => {
    if (!ctx.groupId) return '請在要關閉的群組裡使用此指令';
    if (!isAdmin(ctx.userId)) return '⛔ 僅管理員可用';
    const want = match[1].trim().toLowerCase().split(/\s+/);
    const cur = new Set(groupPerms[ctx.groupId] || []);
    const removed = want.filter(p => cur.has(p));
    removed.forEach(p => cur.delete(p));
    groupPerms[ctx.groupId] = [...cur];
    router.setGroupPermissions(groupPerms);
    persistGroupPerms(ctx.groupId, groupPerms[ctx.groupId]);
    if (!removed.length) return '本群沒有這些功能可關閉';
    return `🗑️ 已關閉：${removed.join('、')}\n本群現可用：${groupPerms[ctx.groupId].join('、') || '（無）'}`;
  }, { type: 'query', name: 'close-plugin', plugin: '_system', describe: '/關閉 <功能> — （管理員）移除本群功能', scope: 'all' });

  // LLM fallback：私訊 + 有 _llm 權限的群組，未匹配指令時用 LLM 回覆
  const llm = registry.get('llm');

  const webhookHandler = createWebhookHandler({
    channelSecret: config.line.channelSecret,
    router,
    lineApi,
    logger,
    onUnmatched: async ({ userId, groupId, sourceType, text, replyToken }) => {
      const isGroup = sourceType === 'group' || sourceType === 'room';
      const trimmed = (text || '').trim();

      // 以 / 開頭但沒命中任何指令 → 打錯/不存在的指令，不丟給 LLM（避免假回覆）
      // （合法但該群沒開權限的指令會在 router 被 groupBlocked 攔下，不會走到這裡）
      if (trimmed.startsWith('/')) {
        const allowed = isGroup ? (groupPerms[groupId] || groupPerms['*'] || []) : null;
        // 私訊一律提示；群組只在有 _llm 的對話型群組提示（避免跨 bot 刷屏）
        if (!isGroup || allowed.includes('_llm')) {
          const cmd = trimmed.split(/\s+/)[0];
          try {
            await lineApi.reply(replyToken, `❓ 找不到指令「${cmd}」\n輸入 /help 查看可用指令`);
          } catch { /* replyToken 過期就算了 */ }
        }
        return;
      }

      if (!llm) {
        console.log(`[fallback] unmatched: ${text.slice(0, 60)}`);
        return;
      }

      // 群組：只有 groups.json 中有 _llm 的群組才觸發 LLM
      if (isGroup) {
        const allowed = groupPerms[groupId] || groupPerms['*'] || [];
        if (!allowed.includes('_llm')) return;
      }

      try {
        const reply = await llm.chat(text, { sessionId: `line-${isGroup ? groupId : userId}` });
        if (reply) {
          try {
            await lineApi.reply(replyToken, reply);
          } catch {
            await lineApi.push(isGroup ? groupId : userId, reply);
          }
        }
      } catch (err) {
        console.error(`[llm-fallback] error: ${err.message}`);
        try {
          await lineApi.reply(replyToken, '抱歉，目前無法處理你的訊息，請稍後再試。');
        } catch { /* replyToken 過期就算了 */ }
      }
    },
  });
  app.post(config.server.webhookPath, webhookHandler);

  // 排程 HTTP trigger
  if (config.scheduler.httpTrigger) {
    app.post(`${config.scheduler.httpPath}/:jobName`, scheduler.httpHandler);
  }

  // Log API
  logger.registerRoutes(app);

  // 管理 API
  app.get('/api/routes', (_req, res) => res.json(router.list()));
  app.get('/api/schedules', (_req, res) => res.json(scheduler.list()));
  app.get('/api/group-permissions', (_req, res) => res.json(router.getGroupPermissions()));
  app.post('/api/schedules/:name/toggle', (req, res) => {
    try {
      const { name } = req.params;
      const scheds = scheduler.list();
      const current = scheds.find(s => s.name === name);
      if (!current) return res.status(404).json({ error: 'not found' });
      const enabled = scheduler.setEnabled(name, !current.enabled);
      res.json({ ok: true, name, enabled });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // LINE Profile 查詢（Dashboard 用）
  const profileCache = new Map(); // id → { data, ts }
  const PROFILE_TTL = 10 * 60_000; // 10 分鐘快取

  app.get('/api/line/profile/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || id.startsWith('(')) return res.json({ error: 'invalid id' });

    // 快取
    const cached = profileCache.get(id);
    if (cached && Date.now() - cached.ts < PROFILE_TTL) {
      return res.json(cached.data);
    }

    try {
      let data;
      if (id.startsWith('C') || id.startsWith('R')) {
        // groupId / roomId
        data = await lineApi.getGroupSummary(id);
        if (data) data._type = 'group';
      } else {
        // userId
        data = await lineApi.getProfile(id);
        if (data) data._type = 'user';
      }
      if (data) {
        profileCache.set(id, { data, ts: Date.now() });
        return res.json(data);
      }
      res.json({ error: 'not found' });
    } catch (err) {
      res.json({ error: err.message });
    }
  });
  app.get('/api/health', (_req, res) => res.json({
    status: 'ok',
    plugins: loaded,
    routes: router.list().length,
    schedules: scheduler.list().length,
    providers: registry.list(),
    uptime: process.uptime(),
  }));

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[linebot-framework] shutting down...');
    logger.close();
    await registry.closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 啟動
  app.listen(config.server.port, () => {
    console.log(`[linebot-framework] running on :${config.server.port}`);
    console.log(`[linebot-framework] webhook: ${config.server.webhookPath}`);
    console.log(`[linebot-framework] plugins: ${loaded.join(', ') || '(none)'}`);
    console.log(`[linebot-framework] providers: ${registry.list().join(', ') || '(none)'}`);
    console.log(`[linebot-framework] routes: ${router.list().length}, schedules: ${scheduler.list().length}`);
  });
}

main().catch(err => {
  console.error('[linebot-framework] fatal:', err);
  process.exit(1);
});
