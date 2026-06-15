# LINE BOT 連線與觸發 技術手冊

> 給其它專案參考用。涵蓋「LINE 怎麼連到你的服務」與「收到後怎麼觸發邏輯」的完整技術細節。
> 範例取自 linebot-framework（Node.js + Express），但原理適用任何語言。
>
> **本手冊不含任何密鑰**。所有 token / secret 以 `<...>` 佔位，實際值放環境變數。

---

## 0. TL;DR（30 秒看懂）

```
LINE App
  │  使用者傳訊息
  ▼
LINE Platform（api.line.me）
  │  POST 你的 webhook（帶 X-Line-Signature）
  ▼
公開 HTTPS 入口（Cloudflare Tunnel / 雲端 / port forward）
  │
  ▼
你的服務（Express :3100）/line/webhook
  │  ① 立即回 200  ② 驗簽章  ③ 去重防重播  ④ 解析事件
  ▼
Router 比對訊息 → 對應 handler → 產生回覆
  │
  ▼
LINE Reply API（用 replyToken，30 秒內）/ Push API（主動推播）
  ▼
使用者收到
```

兩種「觸發」來源：
1. **被動**：使用者傳訊息 → webhook → router 比對 pattern → handler
2. **主動**：排程（cron）/ 事件（如 DB onSnapshot）→ 直接呼叫 Push API

---

## 1. 整體架構

| 元件 | 位置 | 角色 |
|------|------|------|
| LINE Platform | api.line.me | 收發訊息、發 webhook、驗證身分 |
| **公開入口** | Cloudflare Tunnel | 把 `https://bot.example.app` 導到內網主機:3100 |
| Bot 服務 | Mac mini / 任意主機 :3100 | Express webhook + 業務邏輯 |
| 排程器 | 同主機（node-cron） | 定時主動推播 |
| 資料/AI | SQLite / Firestore / LLM | 業務資料與智慧回覆 |

關鍵限制：**LINE 只會打公開的 HTTPS URL**。服務本身可以躲在家裡內網，靠 Tunnel 之類的方式對外。

---

## 2. 對外連線：把 LINE 接到你的服務

### 2.1 為什麼一定要公開 HTTPS

LINE 的 webhook 是 LINE 主動 POST 你，所以你必須有一個：
- **公開可達**的網址（LINE 的伺服器連得到）
- **HTTPS**（LINE 不接受 http）
- 憑證有效（Let's Encrypt / Cloudflare 皆可）

### 2.2 Cloudflare Tunnel（本專案採用，推薦自架情境）

服務在家裡內網（沒有固定 IP / 不想開 port），用 Cloudflare Tunnel 打洞：

```
LINE → https://bot.example.app → Cloudflare 邊緣 → (加密通道) → cloudflared(內網主機) → localhost:3100
```

主機上跑：
```bash
cloudflared tunnel run            # 具名 tunnel，ingress 在 Cloudflare 後台設定
```
Cloudflare 後台 ingress 對應：`bot.example.app` → `http://localhost:3100`。

優點：免開防火牆 port、免固定 IP、自動 HTTPS、DDoS 在邊緣擋掉。
驗證導流是否正常（不碰密鑰）：
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bot.example.app/dashboard   # 期望 200/302
```

### 2.3 其他 ingress 選項

| 方案 | 適用 | 備註 |
|------|------|------|
| Cloudflare Tunnel | 自架、內網主機 | 本專案用法，最省事 |
| 雲端部署（Railway/Render/Fly/Cloud Run） | 無自有主機 | 平台直接給 HTTPS 網址 |
| Port forward + DDNS + 反向代理 | 有固定 IP / 願意開 port | 要自己處理憑證與安全 |
| ngrok | 純本機開發測試 | 免費版網址會變，不適合正式 |

> 換 ingress 不影響程式碼，**只改 LINE 後台的 webhook URL**。

### 2.4 LINE Developer Console 設定

到 [developers.line.biz](https://developers.line.biz)：

1. 建 **Provider** → 建 **Messaging API channel**
2. 拿兩把鑰匙（放環境變數，**絕不進 git**）：
   - **Channel secret**：驗 webhook 簽章用
   - **Channel access token**（long-lived）：呼叫 reply/push 用
3. **Webhook URL** 填：`https://bot.example.app/line/webhook`
4. 開 **Use webhook = ON**
5. 關 **Auto-reply / Greeting messages**（否則官方罐頭訊息會跟你的 bot 打架）
6. （可選）把 bot 加進群組要開 **Allow bot to join group chats**

LINE 後台有「Verify」按鈕，會打一次你的 webhook 驗證可達性。

---

## 3. Webhook：收訊的進入點

LINE 把事件 POST 到你的 webhook。處理順序很重要：

### 3.1 立即回 200，再處理

LINE 要求 webhook **快速回應**（建議 1 秒內），否則會重送。所以**先回 200，事件非同步處理**：

```js
return async function handleWebhook(req, res) {
  res.status(200).end();          // ① 先回，避免 LINE 重送
  // ② 之後才慢慢處理 events（驗簽、解析、執行 handler）
  ...
};
```

> 注意：因為先回 200，後面處理出錯不會讓 LINE 知道。錯誤要自己 log。

### 3.2 簽章驗證（HMAC-SHA256，必做）

LINE 在 header 帶 `X-Line-Signature`，是用 **channel secret** 對 **原始 request body** 做 HMAC-SHA256 再 base64。你要重算比對，擋掉偽造請求：

```js
import { createHmac, timingSafeEqual } from 'crypto';

const signature = req.headers['x-line-signature'];
const hmac = createHmac('sha256', channelSecret).update(req.rawBody).digest('base64');

// 用 timing-safe 比較，避免逐 byte 時間差被推測
const a = Buffer.from(hmac), b = Buffer.from(signature);
if (a.length !== b.length || !timingSafeEqual(a, b)) return;  // 簽章不符 → 丟棄
```

**關鍵**：要拿到「**原始 body bytes**」算 HMAC，不能用 parse 過的 JSON 再 stringify（順序/空白會變）。Express 設定保留 rawBody：

```js
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },  // 保留原始 bytes 供驗簽
}));
```

### 3.3 防重播 + 事件去重

```js
// 防重播：拒絕超過 5 分鐘的舊事件（時間戳）
if (Math.abs(Date.now() - Number(event.timestamp)) > 5*60_000) continue;

// 去重：同一 webhookEventId 只處理一次（LINE 可能重送）
if (recentEventIds.has(event.webhookEventId)) continue;
recentEventIds.set(event.webhookEventId, Date.now());
```

### 3.4 事件解析（來源類型）

```js
for (const event of (data.events || [])) {
  if (event.type !== 'message' || event.message?.type !== 'text') continue; // 只處理文字

  const userId     = event.source?.userId;       // 發訊者（永遠有）
  const sourceType = event.source?.type;          // 'user' | 'group' | 'room'
  const groupId    = event.source?.groupId || null;
  const replyToken = event.replyToken;            // 回覆用，30 秒內有效、只能用一次
  const text       = event.message.text;
}
```

- **私訊**：sourceType `user`，只有 userId
- **群組**：sourceType `group`，有 groupId（成員的 userId 也拿得到）
- **聊天室**：sourceType `room`，有 roomId

> ⚠️ **userId 跨 channel 不一致**：同一個人，在 Messaging API（bot）與 LIFF/Login 看到的 userId **不同**（不同 channel）。要跨系統對應人，用 displayName 或自建綁定表，別假設 userId 通用。

---

## 4. 觸發機制

### 4.1 訊息觸發：Router pattern matching

收到文字後，依序用 regex 比對已註冊的路由，命中就執行 handler：

```js
router.add(/^\/查詢\s+(.+)$/i, async (match, ctx) => {
  const name = match[1];
  return `查詢 ${name} 的結果...`;   // 回傳字串 = 自動回覆給使用者
}, { type: 'query', scope: 'all', plugin: 'demo', describe: '/查詢 <名稱>' });
```

- handler 回傳 **字串或訊息物件** → 框架自動 reply
- `type: 'query'` 會回覆；`type: 'action'` 靜默執行不回覆
- 第一個命中的 route 勝出（注意註冊順序）

**容錯設計建議**（實戰踩過的坑）：
- 中文指令同義字都收：`/^\/[紀記]錄/`（紀錄/記錄）
- 空格寬鬆：`/^\/開通\s*(.+)$/`（沒空格也接受）
- 大小寫：regex 加 `i`，必要時 `.toLowerCase()` 比對參數

### 4.2 Scope 與群組權限

每個 route 有 scope，限制可用場景：

| scope | 私訊 | 群組 |
|-------|:---:|:---:|
| `all` | ✓ | ✓ |
| `private` | ✓ | ✗（回「此指令僅限私訊」） |
| `group` | ✗ | ✓ |

**群組權限白名單**：群組預設全關，只有名單內的 plugin 可用（避免 bot 在每個群亂回）：

```js
// groups.json: { "C群組ID": ["todo", "bike"], "*": ["todo"] }
function isPluginAllowedInGroup(plugin, groupId) {
  if (!groupId) return true;            // 私訊不限
  if (plugin === '_system') return true; // 系統指令不受限
  const allowed = perms[groupId] || perms['*'] || [];
  return allowed.includes(plugin);
}
```

match 的回傳值帶 `scopeBlocked` / `groupBlocked`，webhook 端決定要回提示還是靜默忽略（群組被擋通常**靜默**，避免洗版）。

### 4.3 未匹配的 fallback

訊息沒命中任何 route 時，可接：
- **LLM 兜底**：丟給 AI 自由對話（私訊 / 特定有權限的群組才觸發）
- **指令找不到提示**：以 `/` 開頭卻沒命中 → 回「找不到指令，輸入 /help」，**不要丟給 LLM**（否則 AI 會幻覺出假成功）

```js
onUnmatched: async ({ text, ... }) => {
  if (text.trim().startsWith('/')) return replyNotFound();  // 打錯指令
  return llmFallback(text);                                  // 一般聊天
}
```

### 4.4 排程觸發（主動）：cron + HTTP trigger

定時主動推播，不需使用者開口。用 node-cron：

```js
scheduler.add('morning-remind', '0 8 * * *', async ({ lineApi }) => {
  await lineApi.push('<群組ID>', '早安，今天的行程是...');
}, { timezone: 'Asia/Taipei', pushTo: [{ type:'group', id:'<群組ID>' }] });
```

- cron 格式：`分 時 日 月 週`，預設時區 `Asia/Taipei`
- 一次性提醒：`scheduler.addOnce(name, datetime, handler)`（如「明天 9 點提醒我」）
- **外部觸發**：也開一個 HTTP endpoint，讓外部系統（如雲端 cron、HA automation）打 `POST /api/cron/:jobName` 觸發排程，方便整合。

### 4.5 事件驅動觸發（進階）

資料變動即時推播，例如監聽資料庫：

```js
db.collection('events').onSnapshot(snap => {
  for (const change of snap.docChanges()) {
    if (change.type === 'modified' && change.doc.data().status === 'cancelled') {
      lineApi.push('<群組ID>', `「${change.doc.data().title}」已取消`);
    }
  }
});
```

適合「成績出爐」「活動取消」「即將額滿」這類**外部事件 → 立即通知**的場景。

### 4.6 主動發訊：reply / push / multicast

| API | 用途 | 限制 | 計費 |
|-----|------|------|------|
| **reply** | 回覆收到的訊息 | 要 `replyToken`，**30 秒內、只能用一次** | 免費 |
| **push** | 主動推給單一對象 | 要 userId/groupId | 計入推播額度 |
| **multicast** | 一次推多個 userId | 最多 500 人/次 | 計入額度 |

實戰建議：**能 reply 就 reply（免費），reply 失敗（token 過期）再 fallback push**：

```js
try { await lineApi.reply(replyToken, msg); }
catch { await lineApi.push(userId, msg); }   // token 過期的保險
```

呼叫範例（Authorization 帶 channel access token）：

```js
await fetch('https://api.line.me/v2/bot/message/reply', {
  method: 'POST',
  headers: { 'Content-Type':'application/json', Authorization:`Bearer <ACCESS_TOKEN>` },
  body: JSON.stringify({ replyToken, messages: [{ type:'text', text:'hi' }] }),
});
```

---

## 5. 回覆內容：文字 + Flex Message

- **純文字**：`{ type:'text', text:'...' }`
- **圖片**：`{ type:'image', originalContentUrl, previewImageUrl }`（必須 HTTPS）
- **Flex Message**：自訂排版卡片（JSON 結構），可放按鈕、可點擊

Flex 重點（踩坑提醒）：
- bubble 寬度是**級距**：`nano/micro/kilo/mega(預設)/giga`，不能設像素
- box 的 `alignItems` 只接受 `flex-start/center/flex-end`（**沒有** `baseline`，填了整張卡 push 會 400）
- 互動靠 `action`：`{ type:'uri', uri }` 開網址、`{ type:'message', text }` 模擬使用者送指令（做「點按鈕→送 /todo_done 1」很好用）
- 卡片有大小上限，清單很長要自己截斷

---

## 6. Plugin 架構（如何擴充）

把功能切成 plugin，互不干擾。一個 plugin 長這樣：

```js
export default {
  name: 'demo',
  prefix: 'demo',                 // 可選：自動組 /demo_xxx 指令
  defaultCommand: 'list',         // 裸 /demo 觸發哪個
  scope: 'all',
  helpText: '...',                // 可選：/help demo 顯示的使用說明
  commands: [
    { name:'list', command:'list', describe:'/demo — 清單', type:'query',
      handler: async (m, ctx) => '清單內容' },
    { name:'add', command:'add', pattern:/^(.+)/, describe:'/demo_add <內容>',
      handler: async (m, ctx) => `已新增 ${m[1]}` },
  ],
  schedules: [
    { name:'demo-daily', cron:'0 9 * * *', handler: async ({lineApi}) => {...} },
  ],
  init: async (ctx) => { /* 建表、啟動 listener、註冊額外路由 */ },
};
```

- **prefix 模式**：宣告 `command` 欄，框架自動組 `/<prefix>_<command>`，pattern 只比對參數
- **傳統模式**：不給 prefix，直接寫完整 `pattern`（中文指令如 `/^\/查詢\s+(.+)$/` 用這個）
- `init(ctx)` 拿得到 `lineApi / router / scheduler / db / providers`，可動態 `router.add()`

---

## 7. 把這套用到你自己的專案（整合 Checklist）

最小可動清單：

- [ ] LINE 後台建 Messaging API channel，拿 channel secret + access token
- [ ] 準備公開 HTTPS 入口（Tunnel / 雲端），webhook URL 填 `https://你的網域/line/webhook`
- [ ] 服務啟動時保留 rawBody，實作 **簽章驗證**（HMAC-SHA256 + timing-safe）
- [ ] webhook **先回 200** 再處理；加 **去重 + 防重播**
- [ ] 解析 event：userId / sourceType / groupId / replyToken / text
- [ ] 寫路由：regex → handler，回傳字串自動 reply
- [ ] reply 失敗 fallback push
- [ ] （群組情境）做 scope + 群組權限白名單
- [ ] （需要主動通知）接 cron 排程或事件監聽 → push
- [ ] secret/token 走環境變數，**不進 git**

最小可跑骨架（虛擬碼）：

```js
app.post('/line/webhook', (req, res) => {
  res.status(200).end();
  if (!verifySignature(req)) return;
  for (const ev of req.body.events) {
    if (ev.type === 'message' && ev.message.type === 'text') {
      const reply = route(ev.message.text, ev.source);
      if (reply) lineReply(ev.replyToken, reply).catch(() => linePush(ev.source.userId, reply));
    }
  }
});
```

---

## 8. 安全要點

- **一定要驗簽章**：沒驗 = 任何人都能偽造事件打你的 bot
- **secret / access token / tunnel token 絕不進 git**，只放環境變數
- **群組預設全關**：白名單制，避免 bot 在陌生群亂回 / 被濫用
- **敏感操作加管理員閘門**：如「廣播到家裡喇叭」「改權限」只給特定 userId
- **不信任輸入**：使用者文字直接進 regex/SQL 要參數化，別字串拼接
- **replyToken 一次性**：別存起來重用

---

## 9. 疑難排解

| 症狀 | 可能原因 | 查法 |
|------|----------|------|
| LINE Verify 失敗 | webhook URL 錯 / 服務沒起 / Tunnel 沒通 | `curl https://網域/line/webhook`（應非連線錯誤） |
| 收得到但不回 | 簽章驗證失敗（rawBody 沒保留）/ handler 丟錯 | log 印 `invalid signature` / handler error |
| 群組沒反應 | 該群沒在權限白名單 / scope 不符 | 查 groups.json / route 的 scope |
| 打錯指令沒反應 | 沒命中 route 又被靜默丟棄 | 確認 fallback 有回「找不到指令」 |
| reply 沒效果 | replyToken 過期（>30s）/ 已用過 | 改判斷 + fallback push |
| Flex 卡 push 400 | 無效屬性（如 alignItems:baseline） | 看 LINE 回的 error property 路徑 |
| 排程沒跑 | cron 字串錯 / 時區錯 | 確認 timezone、用 HTTP trigger 手動測 |

---

## 附錄 A：環境變數

| 變數 | 用途 |
|------|------|
| `LINE_CHANNEL_SECRET` | 驗 webhook 簽章 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 呼叫 reply/push API |
| `PORT` | 服務埠（本專案 3100） |

## 附錄 B：常用 LINE API 端點

| 端點 | 方法 | 用途 |
|------|------|------|
| `/v2/bot/message/reply` | POST | 回覆（replyToken） |
| `/v2/bot/message/push` | POST | 主動推播 |
| `/v2/bot/message/multicast` | POST | 多人推播（≤500） |
| `/v2/bot/profile/{userId}` | GET | 查使用者 profile |
| `/v2/bot/group/{groupId}/summary` | GET | 查群組摘要 |

## 附錄 C：本專案實際拓樸

```
LINE → https://bot.pushbike-training.app/line/webhook
     → Cloudflare Tunnel（cloudflared tunnel run @ Mac mini）
     → localhost:3100（Express, linebot-framework）
     → Router + Plugins（SQLite / Firestore / LLM）
排程：node-cron（同主機）+ POST /api/cron/:jobName（外部觸發）
主動廣播：bot → 家裡 PC 192.168.0.229:9880 TTS（語音播報）
```

---

*本手冊隨框架演進更新。原始實作：`src/core/{webhook,router,line-api,scheduler}.js`、`src/core/plugin-loader.js`。*
