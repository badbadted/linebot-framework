# 對外推播 API 技術手冊（POST /api/push）

> 給「其它系統／腳本／AI」把訊息主動推到 LINE 用。範例取自 linebot-framework
> （Node.js + Express，跑在 Mac mini），原理適用任何語言。
>
> **本手冊不含任何密鑰**。

---

## 0. TL;DR

其它系統要推 LINE，打這支即可（區網／本機免金鑰）：

```bash
curl -X POST http://192.168.0.222:3100/api/push \
  -H "Content-Type: application/json" \
  -d '{ "to": "me", "text": "要推的內容" }'
```

成功回 `{"ok":true,"to":"U...","sentAt":"..."}`。

---

## 1. 端點與連線

| 項目 | 值 |
|------|-----|
| 服務位置 | **Mac mini `192.168.0.222` port `3100`**（launchd：`com.linebot.framework`）|
| 區網 URL | `http://192.168.0.222:3100/api/push` |
| 外網 URL | `https://bot.pushbike-training.app/api/push`（經 Cloudflare Tunnel）|
| Method | `POST` |

⚠️ **常見連不上原因**：
- 用 `localhost:3100` → 打到呼叫方自己那台，不是 Mac mini。服務只在 Mac mini。
- 用 `macmini.local` → mDNS 從 Windows / 跨網段常解不到。**直接用 IP `192.168.0.222` 最穩**。
- 服務沒跑 → `curl http://192.168.0.222:3100/api/health` 應回 `{"status":"ok",...}`。

---

## 2. 請求格式

```jsonc
// 純文字
{ "to": "me", "text": "訊息內容" }

// Flex 卡片：改用 message 帶 LINE 訊息物件
{ "to": "me", "message": { "type": "flex", "altText": "...", "contents": { ... } } }
```

`to` 可用值：
- `"me"` → 管理員本人（免記 userId；對應 `config/admin.json` 的第一個 adminUserId）
- 直接給 `userId`（`U…`）或 `groupId`（`C…`）

回應碼：`200 ok` / `400 缺 to 或 text` / `403 外網未帶金鑰` / `502 LINE 推播失敗`。

---

## 3. 授權模型（重點：本機免金鑰、外網需金鑰）

驗證在 `src/core/api-auth.js`，保護所有 `/api/*`：

- **本機／區網直連（無 Cloudflare 標頭）→ 免金鑰**，直接放行。
- **外網（經 Cloudflare Tunnel，帶 `CF-Connecting-IP` / `CF-Ray`）→ 必須 `X-API-Key`**（值 = 環境變數 `API_KEY`）；未設 `API_KEY` 時外網一律 403。

### ⚠️ 為什麼不能只用 IP 判斷本機（關鍵 pitfall）

Cloudflare Tunnel 是把外網請求**轉發到 localhost**，所以程式端看到的 `req.ip` 會是 `127.0.0.1`——**外網請求長得跟本機一模一樣**。若只用「IP 是不是區網」放行，等於把整個 `/api/*` 對全世界開放（曾實測外網不帶任何金鑰就能推 LINE 給任意人）。

**正解**：用 **Cloudflare 邊緣標頭**辨識來源——凡帶 `cf-connecting-ip` / `cf-ray` 者一律當「外網」、只能靠金鑰；沒有這些標頭的才是真本機/區網直連、才免金鑰。這招適用任何「本地服務 + Tunnel 對外」的架構。

```js
const viaCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
if (!viaCloudflare) {
  // 真本機/區網：免金鑰放行
  if (isLocalOrLan(req.ip)) return next();
}
// 外網或未過 → 需 API_KEY
```

---

## 4. 提示詞（貼給另一個系統／AI 設定用）

```
把訊息推到我的 LINE：
POST http://192.168.0.222:3100/api/push
Content-Type: application/json
Body: { "to": "me", "text": "<要通知我的內容>" }

- 推給我本人 "to" 固定填 "me"；純文字用 "text"，Flex 卡片用 "message"。
- 區網直打免金鑰。成功回 {"ok":true,...}。
- 連不上先確認用的是 192.168.0.222:3100（不是 localhost / macmini.local）。
```

---

## 5. 未來要在別的伺服器加同樣能力

1. 開一支 `POST /api/push`，body `{ to, text|message }`，內部呼叫該平台的 LINE push（`lineApi.push(to, payload)`，底層打 `api.line.me/v2/bot/message/push`）。
2. `to` 支援別名（`me` → 管理員 userId），呼叫方不用記長 id。
3. **授權務必用「來源標頭」而非「IP」判斷本機**（見第 3 節 pitfall），否則 Tunnel 會讓外網繞過。
4. 對外預設關（未設金鑰即 403），本機/區網免金鑰，符合「自己系統內部串接」的常見用法。
