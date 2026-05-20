# linebot-framework

通用 LINE BOT 框架 — Regex Router + Plugin 架構 + 定時推播。

不依賴 LLM，純路由 + 固定動作。需要 LLM 時透過 `onUnmatched` callback 自行串接。

## 架構

```
訊息進來 → Webhook（簽章驗證）→ Router（regex 比對）
  ├─ 命中 → Plugin handler 執行
  │    ├─ action 類型 → 靜默執行，不回覆
  │    └─ query 類型  → 執行後回覆結果
  └─ 沒命中 → onUnmatched（選填：接 LLM / 靜態回覆 / 忽略）

排程器 → node-cron 定時觸發 → LINE Push API 推播
       → HTTP POST /api/cron/:jobName 外部觸發
```

## 前置需求

- Node.js ≥ 18
- LINE Developers 帳號（[建立方式見下方](#line-channel-設定)）

## 安裝

```bash
git clone https://github.com/badbadted/linebot-framework.git
cd linebot-framework
npm install
```

## LINE Channel 設定

1. 前往 [LINE Developers Console](https://developers.line.biz/console/)
2. 建立 Provider（或選現有的）
3. 建立 **Messaging API Channel**
4. 取得以下資訊：
   - **Channel Secret**：Basic settings → Channel secret
   - **Channel Access Token**：Messaging API → Issue（長期）
5. Webhook URL 設定：Messaging API → Webhook URL → 填入 `https://<你的網域>/line/webhook`
6. 關閉「Auto-reply messages」和「Greeting messages」（在 LINE Official Account Manager）

## 設定

### 方式一：環境變數（推薦）

```bash
export LINE_CHANNEL_SECRET="你的 channel secret"
export LINE_CHANNEL_ACCESS_TOKEN="你的 channel access token"
export PORT=3100  # 可選，預設 3100
```

或建立 `.env` 檔（不會被 git 追蹤）：

```
LINE_CHANNEL_SECRET=你的 channel secret
LINE_CHANNEL_ACCESS_TOKEN=你的 channel access token
```

> 框架本身不讀 `.env`，需搭配 `--env-file=.env`（Node 20.6+）或自行加 dotenv。

### 方式二：config 檔

編輯 `config/default.json`：

```json
{
  "line": {
    "channelSecret": "你的 channel secret",
    "channelAccessToken": "你的 channel access token"
  },
  "server": {
    "port": 3100,
    "webhookPath": "/line/webhook"
  },
  "plugins": {
    "dir": "./plugins",
    "enabled": []
  },
  "scheduler": {
    "httpTrigger": true,
    "httpPath": "/api/cron"
  }
}
```

| 欄位 | 說明 |
|------|------|
| `plugins.enabled` | 空陣列 = 載入全部 plugin；指定名稱 = 只載入白名單內的 |
| `scheduler.httpTrigger` | `true` 開啟 HTTP 觸發端點，`false` 關閉 |

環境變數優先於 config 檔。

## 啟動

```bash
# 正式
npm start

# 開發（檔案變更自動重啟，需 Node 18.11+）
npm run dev
```

啟動成功會看到：

```
[linebot-framework] running on :3100
[linebot-framework] webhook: /line/webhook
[linebot-framework] plugins: echo
[linebot-framework] routes: 2, schedules: 1
```

## 對外公開（Webhook 需要 HTTPS）

LINE webhook 需要 HTTPS URL。開發階段可用以下方式：

### ngrok（最簡單）

```bash
ngrok http 3100
```

取得 `https://xxxx.ngrok-free.app`，填入 LINE Developers Console 的 Webhook URL。

### Cloudflare Tunnel（正式環境推薦）

```bash
cloudflared tunnel --url http://localhost:3100
```

或設定固定 tunnel 綁定自訂網域。

## 寫 Plugin

在 `plugins/` 建立目錄，包含 `index.js`：

```
plugins/
└── my-bot/
    └── index.js
```

### Plugin 結構

```js
export default {
  name: 'my-bot',

  // 路由指令
  commands: [
    {
      name: 'greeting',
      pattern: /^(你好|哈囉|嗨)$/,
      type: 'query',     // 'query' = 回覆結果，'action' = 靜默執行
      handler: async (match, ctx) => {
        // match: regex match 結果
        // ctx: { userId, replyToken, lineApi, event }
        return `你好！👋`;
      },
    },
    {
      name: 'do-something',
      pattern: /^執行任務$/,
      type: 'action',     // 不回覆
      handler: async (match, ctx) => {
        // 做事...不需要回傳
      },
    },
  ],

  // 定時排程
  schedules: [
    {
      name: 'daily-report',
      cron: '0 18 * * 1-5',   // 週一到五下午 6 點
      handler: async ({ lineApi }) => {
        await lineApi.push('U使用者ID', '下班了！今日報告...');
      },
    },
  ],

  // 初始化（可選）
  init: async ({ lineApi, router, scheduler }) => {
    console.log('my-bot plugin initialized');
  },
};
```

### handler 參數

| 參數 | 說明 |
|------|------|
| `match` | `RegExp.match()` 結果，`match[1]` 是第一個捕獲群組 |
| `ctx.userId` | 發訊者 LINE userId |
| `ctx.replyToken` | LINE replyToken（30 秒內有效） |
| `ctx.lineApi` | `{ reply, push, multicast }` |
| `ctx.event` | 原始 LINE webhook event |

### Cron 語法

```
┌─── 分（0-59）
│ ┌─── 時（0-23）
│ │ ┌─── 日（1-31）
│ │ │ ┌─── 月（1-12）
│ │ │ │ ┌─── 星期（0-7，0 和 7 都是週日）
│ │ │ │ │
* * * * *
```

常用範例：
- `0 8 * * *` — 每天早上 8 點
- `*/30 * * * *` — 每 30 分鐘
- `0 9 * * 1` — 每週一早上 9 點
- `0 18 * * 1-5` — 週一到五下午 6 點

## 管理 API

| 端點 | 說明 |
|------|------|
| `GET /api/health` | 健康檢查（plugins、routes、schedules、uptime） |
| `GET /api/routes` | 列出所有已註冊的路由 |
| `GET /api/schedules` | 列出所有排程任務 |
| `POST /api/cron/:jobName` | 手動觸發排程任務 |

## 接 LLM（選填）

框架本身不含 LLM。需要時修改 `src/index.js` 的 `onUnmatched`：

```js
const webhookHandler = createWebhookHandler({
  channelSecret: config.line.channelSecret,
  router,
  lineApi,
  onUnmatched: async ({ userId, text, replyToken }) => {
    // 範例：接 OpenAI
    const reply = await callOpenAI(text);
    await lineApi.reply(replyToken, reply);
  },
});
```

或寫成 plugin 的 `init` hook 覆蓋 fallback 行為。

## 部署

### PM2（推薦）

```bash
npm install -g pm2
pm2 start src/index.js --name linebot
pm2 save
pm2 startup  # 開機自動啟動
```

### launchd（macOS）

建立 `~/Library/LaunchAgents/com.linebot.framework.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.linebot.framework</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/linebot-framework/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/linebot-framework</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LINE_CHANNEL_SECRET</key>
    <string>你的 secret</string>
    <key>LINE_CHANNEL_ACCESS_TOKEN</key>
    <string>你的 token</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.linebot.framework.plist
```

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3100
CMD ["node", "src/index.js"]
```

```bash
docker build -t linebot-framework .
docker run -d -p 3100:3100 \
  -e LINE_CHANNEL_SECRET=xxx \
  -e LINE_CHANNEL_ACCESS_TOKEN=xxx \
  linebot-framework
```

## Plugin 範例場景

| 場景 | Plugin 做法 |
|------|------------|
| 工作打卡通知 | schedule: 週一至五 8:50 推播提醒 |
| 運動追蹤 | command: `跑步 5km` → 記錄到 DB → 回覆本週統計 |
| 家庭自動化 | command: `開冷氣` → 呼叫 Home Assistant API |
| 匯率查詢 | command: `美金` → 抓即時匯率 → 回覆 |
| 定時爬蟲 | schedule: 每天 7 點爬新聞 → push 摘要 |
| 群組管理 | command: `/ban @user` → 呼叫 LINE API 踢人 |

## 白名單（可選）

`createWebhookHandler` 支援 `allowlist` 參數（`Set<string>`），未在名單內的 userId 會被擋掉並回覆提示訊息。不設就不擋。
