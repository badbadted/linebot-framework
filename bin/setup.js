#!/usr/bin/env node

/**
 * linebot-framework Setup 精靈
 *
 * 互動式引導設定 LINE 憑證、Providers、伺服器參數。
 * 產出：config/default.json + .env
 *
 * 用法：npm run setup
 */

import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(ROOT, 'config/default.json');
const ENV_PATH = resolve(ROOT, '.env');

// ── readline 工具 ────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultValue = '') {
  const hint = defaultValue ? ` (${defaultValue})` : '';
  return new Promise(r => {
    rl.question(`  ${question}${hint}: `, answer => {
      r(answer.trim() || defaultValue);
    });
  });
}

function askYN(question, defaultYes = false) {
  const hint = defaultYes ? '(Y/n)' : '(y/N)';
  return new Promise(r => {
    rl.question(`  ${question} ${hint}: `, answer => {
      const a = answer.trim().toLowerCase();
      if (!a) return r(defaultYes);
      r(a === 'y' || a === 'yes');
    });
  });
}

function askChoice(question, choices) {
  const list = choices.map((c, i) => `[${i + 1}] ${c}`).join('  ');
  return new Promise(r => {
    rl.question(`  ${question} ${list}: `, answer => {
      const idx = parseInt(answer.trim(), 10) - 1;
      r(choices[idx >= 0 && idx < choices.length ? idx : 0]);
    });
  });
}

// ── 讀取現有設定 ──────────────────────────────────────
function loadExisting() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function loadExistingEnv() {
  const env = {};
  try {
    if (existsSync(ENV_PATH)) {
      const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    }
  } catch { /* ignore */ }
  return env;
}

// ── 主流程 ────────────────────────────────────────────
async function main() {
  console.log();
  console.log('🤖 linebot-framework 設定精靈');
  console.log('──────────────────────────────');
  console.log();

  const existing = loadExisting();
  const existingEnv = loadExistingEnv();
  const envVars = {};

  // ── Step 1: LINE Channel ──
  console.log('📌 Step 1/3 — LINE Channel 設定');
  console.log();

  const channelSecret = await ask(
    '? Channel Secret',
    existingEnv.LINE_CHANNEL_SECRET || ''
  );
  const channelAccessToken = await ask(
    '? Channel Access Token',
    existingEnv.LINE_CHANNEL_ACCESS_TOKEN || ''
  );

  envVars.LINE_CHANNEL_SECRET = channelSecret;
  envVars.LINE_CHANNEL_ACCESS_TOKEN = channelAccessToken;

  console.log();

  // ── Step 2: Providers ──
  console.log('📌 Step 2/3 — 外接服務（Providers）');
  console.log();

  const providers = {};

  // DB
  const hasDB = existing.providers?.db;
  const wantDB = await askYN('? 啟用資料庫？', hasDB !== undefined ? true : true);
  if (wantDB) {
    const dbType = await askChoice('→ 類型：', ['sqlite']);
    const dbDir = await ask('→ 資料目錄', existing.providers?.db?.dir || './data');
    const dbMode = await askChoice('→ 模式：', ['isolated', 'shared']);
    providers.db = { type: dbType, dir: dbDir, mode: dbMode };
  }

  console.log();

  // LLM
  const hasLLM = existing.providers?.llm;
  const wantLLM = await askYN('? 啟用 LLM？', hasLLM !== undefined);
  if (wantLLM) {
    const llmType = await askChoice('→ 類型：', ['gemini', 'openai']);
    const envKeyMap = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };
    const defaultEnvKey = envKeyMap[llmType];
    const apiKeyEnv = await ask(`→ API Key 環境變數名`, defaultEnvKey);
    const apiKeyValue = await ask(`→ ${apiKeyEnv} 的值`, existingEnv[apiKeyEnv] || '');

    const modelDefaults = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o' };
    const model = await ask('→ Model', existing.providers?.llm?.model || modelDefaults[llmType]);

    providers.llm = { type: llmType, apiKey: `$${apiKeyEnv}`, model };
    envVars[apiKeyEnv] = apiKeyValue;

    if (llmType === 'openai') {
      const baseUrl = await ask('→ Base URL', existing.providers?.llm?.baseUrl || 'https://api.openai.com/v1');
      providers.llm.baseUrl = baseUrl;
    }
  }

  console.log();

  // Cache
  const hasCache = existing.providers?.cache;
  const wantCache = await askYN('? 啟用 Cache？', hasCache !== undefined);
  if (wantCache) {
    const ttl = await ask('→ 預設 TTL（秒）', String(existing.providers?.cache?.ttl || 300));
    providers.cache = { type: 'memory', ttl: parseInt(ttl, 10) };
  }

  console.log();

  // ── Step 3: Server ──
  console.log('📌 Step 3/3 — 伺服器設定');
  console.log();

  const port = await ask('? Port', String(existing.server?.port || 3100));
  const webhookPath = await ask('? Webhook 路徑', existing.server?.webhookPath || '/line/webhook');
  const pluginsDir = await ask('? Plugin 目錄', existing.plugins?.dir || './plugins');
  const httpTrigger = await askYN('? 開啟排程 HTTP 觸發？', existing.scheduler?.httpTrigger !== false);

  console.log();

  // ── 產出 config ──
  const config = {
    line: {
      channelSecret: '',
      channelAccessToken: '',
    },
    server: {
      port: parseInt(port, 10),
      webhookPath,
    },
    plugins: {
      dir: pluginsDir,
      enabled: existing.plugins?.enabled || [],
    },
    scheduler: {
      httpTrigger,
      httpPath: existing.scheduler?.httpPath || '/api/cron',
    },
    providers,
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // ── 產出 .env ──
  // 合併現有 .env（保留不相關的變數）
  const mergedEnv = { ...existingEnv, ...envVars };
  // 移除空值
  for (const [k, v] of Object.entries(mergedEnv)) {
    if (!v) delete mergedEnv[k];
  }
  const envContent = Object.entries(mergedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
  writeFileSync(ENV_PATH, envContent, 'utf-8');

  // ── 完成 ──
  console.log('✅ 設定完成！已產生：');
  console.log(`  📄 config/default.json`);
  console.log(`  📄 .env`);
  console.log();

  // 摘要
  console.log('  設定摘要：');
  console.log(`  ├─ Port: ${port}`);
  console.log(`  ├─ Webhook: ${webhookPath}`);
  console.log(`  ├─ DB: ${providers.db ? `${providers.db.type} (${providers.db.dir})` : '未啟用'}`);
  console.log(`  ├─ LLM: ${providers.llm ? `${providers.llm.type} (${providers.llm.model})` : '未啟用'}`);
  console.log(`  └─ Cache: ${providers.cache ? `memory (TTL ${providers.cache.ttl}s)` : '未啟用'}`);
  console.log();

  // 提示未填的 API Key
  const emptyKeys = Object.entries(envVars).filter(([, v]) => !v);
  if (emptyKeys.length > 0) {
    console.log('  ⚠️  請編輯 .env 填入：');
    for (const [k] of emptyKeys) {
      console.log(`     ${k}=你的金鑰`);
    }
    console.log();
  }

  console.log('  下一步：');
  console.log('  1. npm start     啟動框架');
  console.log('  2. npm run dev   開發模式（自動重啟）');
  console.log();

  rl.close();
}

main().catch(err => {
  console.error('Setup 失敗:', err.message);
  rl.close();
  process.exit(1);
});
