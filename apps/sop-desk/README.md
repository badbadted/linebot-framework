# 公司文件查詢（sop-desk）

自用本機 App：在自己電腦上查公司開發規範與 KM 文件。輸入問題，右邊先列出最相關的原文段落，中間再由 Claude 整理成答案並附出處（點 [n] 會捲到對應段落）。

和 LINE 群組的 `/sop` 共用同一份知識庫（`data/kb/sop-kb.db`）與同一套檢索、引用驗證、網址過濾程式（`plugins/sop/`）。

## 需求

- Node.js 18+（repo 已裝 better-sqlite3）
- 本機 Ollama + bge-m3（問題轉向量）
- Claude Code CLI，且**已登入**：在 PowerShell 執行 `claude auth login`（用自己的訂閱，不需要 API 金鑰）
- 知識庫：`node bin/sop-kb-sync.mjs --dry-run` 會產生 / 更新 `data/kb/sop-kb.db`

## 使用

- 第一次：`powershell -ExecutionPolicy Bypass -File apps/sop-desk/make-shortcut.ps1` 在桌面建立「公司文件查詢」捷徑
- 之後點捷徑即可：伺服器沒開會在背景開好，再用 Chrome 應用程式視窗打開 http://127.0.0.1:4790/
- 想裝成 Chrome 應用程式：在畫面上按網址列右邊的「安裝」
- 伺服器閒置 30 分鐘自動結束；紀錄在 `data/sop-desk/history.db`、log 在 `data/sop-desk/server.log`

## 安全

- 只綁 127.0.0.1；Host 必須是 127.0.0.1／localhost:4790；會花額度或改資料的請求要同源、帶 `X-Sop-Desk` 標頭與 JSON；不送 CORS 標頭；CSP 只允許自己
- Claude 用 `claude -p --tools "" --safe-mode --strict-mcp-config …`：沒有任何工具與 MCP，不載 CLAUDE.md／hooks；問題與段落走 stdin，cwd 是空的暫存資料夾
- 同時只整理一題，每分鐘最多 6 題
- 前端只用 textContent，不把文字轉成連結

## 測試

```
node tests/test-sop-desk.mjs
```
