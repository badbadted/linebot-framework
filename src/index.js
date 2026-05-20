/**
 * linebot-framework — 主入口
 *
 * 啟動流程：
 * 1. 讀取設定
 * 2. 初始化核心模組（router, scheduler, line-api）
 * 3. 載入 plugins
 * 4. 啟動 Express server
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
import { createDatabaseProvider } from './core/database.js';

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
    database: {
      dir: resolve(ROOT, config.database?.dir || './data'),
      mode: config.database?.mode || 'isolated',
    },
  };
}

// ── 主程式 ────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  // 初始化核心
  const lineApi = createLineAPI(config.line.channelAccessToken);
  const router = createRouter();
  const scheduler = createScheduler({ lineApi });
  const dbProvider = createDatabaseProvider(config.database.dir, { mode: config.database.mode });

  // 載入 plugins
  const loaded = await loadPlugins(config.plugins.dir, {
    router,
    scheduler,
    lineApi,
    dbProvider,
    enabledList: config.plugins.enabled,
  });

  // Express
  const app = express();

  // rawBody 保留（LINE 簽章驗證需要）
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // LINE webhook
  const webhookHandler = createWebhookHandler({
    channelSecret: config.line.channelSecret,
    router,
    lineApi,
    onUnmatched: async ({ userId, text, replyToken }) => {
      // 預設 fallback：回覆「不認識這個指令」
      // Plugin 或使用者可覆蓋這個行為（如接 LLM）
      console.log(`[fallback] unmatched: ${text.slice(0, 60)}`);
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
    uptime: process.uptime(),
  }));

  // 啟動
  app.listen(config.server.port, () => {
    console.log(`[linebot-framework] running on :${config.server.port}`);
    console.log(`[linebot-framework] webhook: ${config.server.webhookPath}`);
    console.log(`[linebot-framework] plugins: ${loaded.join(', ') || '(none)'}`);
    console.log(`[linebot-framework] routes: ${router.list().length}, schedules: ${scheduler.list().length}`);
  });
}

main().catch(err => {
  console.error('[linebot-framework] fatal:', err);
  process.exit(1);
});
