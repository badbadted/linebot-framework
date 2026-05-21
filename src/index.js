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
import { readFileSync } from 'fs';
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

  // LLM：若有設定 LLM provider，註冊 /ask 指令供群組使用
  const llm = registry.get('llm');

  if (llm) {
    router.add(/^\/ask\s+(.+)/i, async (match, ctx) => {
      const question = match[1];
      const reply = await llm.chat(question, { sessionId: `line-${ctx.userId}` });
      return reply || '🤔 沒有回應';
    }, {
      type: 'query',
      name: 'ask-llm',
      plugin: '_system',
      describe: '/ask <問題> — 問 AI',
      scope: 'all',
    });
  }

  // LLM fallback：私訊未匹配指令時用 LLM 回覆（群組不觸發）

  const webhookHandler = createWebhookHandler({
    channelSecret: config.line.channelSecret,
    router,
    lineApi,
    logger,
    onUnmatched: async ({ userId, sourceType, text, replyToken }) => {
      if (!llm) {
        console.log(`[fallback] unmatched: ${text.slice(0, 60)}`);
        return;
      }

      // 群組中只有 /ask 指令才觸發 LLM，私訊任何訊息都可以
      const isGroup = sourceType === 'group' || sourceType === 'room';
      if (isGroup) return; // 群組不回應未匹配訊息

      try {
        const reply = await llm.chat(text, { sessionId: `line-${userId}` });
        if (reply) {
          try {
            await lineApi.reply(replyToken, reply);
          } catch {
            await lineApi.push(userId, reply);
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
