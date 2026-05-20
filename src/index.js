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

  // LLM fallback：若有設定 LLM provider，未匹配指令時用 LLM 回覆
  const llm = registry.get('llm');

  const webhookHandler = createWebhookHandler({
    channelSecret: config.line.channelSecret,
    router,
    lineApi,
    onUnmatched: async ({ userId, text, replyToken }) => {
      if (llm) {
        try {
          const reply = await llm.chat(text);
          await lineApi.reply(replyToken, reply);
        } catch (err) {
          console.error(`[llm-fallback] error: ${err.message}`);
        }
      } else {
        console.log(`[fallback] unmatched: ${text.slice(0, 60)}`);
      }
    },
  });
  app.post(config.server.webhookPath, webhookHandler);

  // 排程 HTTP trigger
  if (config.scheduler.httpTrigger) {
    app.post(`${config.scheduler.httpPath}/:jobName`, scheduler.httpHandler);
  }

  // 管理 API
  app.get('/api/routes', (_req, res) => res.json(router.list()));
  app.get('/api/schedules', (_req, res) => res.json(scheduler.list()));
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
