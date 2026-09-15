# ops — 運維腳本

本目錄放「顧這套 bot 活著」的腳本，不屬於框架本體。

## linebot-watchdog.ps1（外部監測）

從 Windows 這端定時探測 **公網入口**，連續失敗就透過 **區網 push API** 通知 LINE。

### 為什麼需要

2026-08-03 Mac mini 重開機後 cloudflared 沒跟著起來。bot 服務本身完全正常
（`/api/health` 回 200、uptime 兩天），但 LINE 的 webhook 打到 Cloudflare 就斷在
邊緣（HTTP 530 / error 1033），訊息根本進不到 bot。**服務健康但對外是死的**，
沒有任何東西會告訴你，結果無感持續約 2.5 天。

站在機器內部的健康檢查看不到這種故障，必須從外面打。

### 設計要點

- 探測目標是**公網** `https://bot.pushbike-training.app/dashboard`——走的正是 LINE 走的那條路
- 通知走**區網** `http://192.168.0.222:3100/api/push`（免金鑰）。刻意不走公網：
  通道掛掉時公網正是死的那條路，拿它送警報等於沒有警報
- 連續失敗 2 次（約 10 分鐘）才告警，避開瞬斷誤報；告警只發一次，不每 5 分鐘洗版
- 告警內容順手判斷是「只有通道掛」還是「整台掛」，直接把下一步指令寫進通知
- 恢復時補一則通知

### 使用

```powershell
# 註冊排程（每 5 分鐘，當前使用者、登入後執行，免管理員權限）
powershell -ExecutionPolicy Bypass -File ops\install-watchdog-task.ps1

# 手動跑一次
powershell -ExecutionPolicy Bypass -File ops\linebot-watchdog.ps1

# 驗證通知管道（會實際發一則 LINE 訊息給管理員）
powershell -ExecutionPolicy Bypass -File ops\linebot-watchdog.ps1 -SendTestAlert

# 移除排程
schtasks /Delete /TN LinebotWatchdog /F
```

### 排程怎麼執行

排程工作 `LinebotWatchdog` 不直接跑 `linebot-watchdog.ps1`，而是經過兩層：

```
wscript.exe → linebot-watchdog-hidden.vbs → linebot-watchdog-run.ps1 → linebot-watchdog.ps1
```

| 檔案 | 作用 |
|---|---|
| `linebot-watchdog-hidden.vbs` | 以隱藏視窗啟動。直接跑 PowerShell 時，Windows 會在 PowerShell 套用 `-WindowStyle Hidden` 前先開主控台，每 5 分鐘閃一次黑色視窗 |
| `linebot-watchdog-run.ps1` | 用 call operator 執行 watchdog，每次都寫 `runner.log`。排程直接 `-File` 執行時曾回報 exit 0 卻沒真的跑，監測看起來正常其實已經失效 |
| `linebot-watchdog.ps1` | 真正的探測與通知邏輯 |

`install-watchdog-task.ps1` 會照這個方式註冊。`.vbs` 與 `-run.ps1` 裡寫死了本 repo 的路徑（`C:\Ted\Projects\devtools\linebot-framework\ops\`），搬移 repo 時要一起改。

狀態與日誌都在 `%LOCALAPPDATA%\linebot-watchdog\`：

| 檔案 | 內容 |
|---|---|
| `state.json` | 連續失敗次數、是否已告警 |
| `watchdog.log` | 告警與恢復紀錄 |
| `runner.log` | 每次執行的結果與輸出（超過 512 KB 只留最後 1000 行） |
| `launcher.log` | `.vbs` 啟動與 PowerShell 回傳碼（同樣超過 512 KB 只留最後 1000 行） |

排查「監測好像沒在跑」時，先看 `runner.log` 最後一次時間，再看 `launcher.log` 有沒有對應的啟動紀錄。

### 已知限制

這台 Windows 關機時就不會監測。要涵蓋「Mac mini 整台失聯」且不依賴自家設備，
需再加一個雲端 uptime 服務（Cloudflare Health Checks / UptimeRobot）打同一個 URL。
