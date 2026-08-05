# linebot-watchdog.ps1
# 從外部（Windows）探測 LINE BOT 的公網入口，掛掉時透過區網 push API 通知。
#
# 背景：2026-08-03 重開機後 cloudflared 沒起來，bot 本身健康但 webhook 進不來，
#       無感持續約 2.5 天。本腳本專門補這個盲點——只從「LINE 打得到嗎」的角度判斷。
#
# 排程：Windows 工作排程器每 5 分鐘一次（見 ops/README.md）
# 狀態/日誌：%LOCALAPPDATA%\linebot-watchdog\

param(
    [string]$PublicUrl = 'https://bot.pushbike-training.app/dashboard',
    [string]$LanHealthUrl = 'http://192.168.0.222:3100/api/health',
    [string]$PushUrl = 'http://192.168.0.222:3100/api/push',
    [int]$FailThreshold = 2,          # 連續失敗幾次才告警（每次間隔 5 分 → 2 次約 10 分鐘）
    [switch]$SendTestAlert            # 只發一則測試通知後結束，用來驗證通知管道
)

$ErrorActionPreference = 'Stop'

$StateDir  = Join-Path $env:LOCALAPPDATA 'linebot-watchdog'
$StateFile = Join-Path $StateDir 'state.json'
$LogFile   = Join-Path $StateDir 'watchdog.log'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
    # 日誌超過 1MB 就砍掉前半，避免無限長大
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
        $keep = Get-Content $LogFile -Encoding UTF8 | Select-Object -Last 2000
        Set-Content -Path $LogFile -Value $keep -Encoding UTF8
    }
}

# 送出通知：走區網直打 bot 的 /api/push（免金鑰）。
# 刻意不走公網——通道掛掉時公網正是死的那條路。
function Send-Alert([string]$Text) {
    try {
        $json  = @{ to = 'me'; text = $Text } | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        Invoke-RestMethod -Uri $PushUrl -Method Post `
            -ContentType 'application/json; charset=utf-8' `
            -Body $bytes -TimeoutSec 10 | Out-Null
        Write-Log "[通知已送出] $Text"
        return $true
    } catch {
        # 連區網 push 都失敗 → Mac mini 整台或 bot 服務也倒了，只能落地成日誌
        Write-Log "[通知失敗] $($_.Exception.Message) — 原訊息：$Text"
        return $false
    }
}

function Get-HttpCode([string]$Url, [int]$TimeoutSec = 15) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time $TimeoutSec $Url 2>$null
    if ($LASTEXITCODE -ne 0) { return 0 }
    if ($code -match '^\d+$') { return [int]$code }
    return 0
}

if ($SendTestAlert) {
    $sent = Send-Alert "🔔 linebot 監測測試：通知管道正常（來自 $env:COMPUTERNAME）"
    if (-not $sent) { exit 1 }
    exit 0
}

# --- 讀狀態 ---
$state = @{ fails = 0; alerted = $false }
if (Test-Path $StateFile) {
    try {
        $loaded = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $state.fails   = [int]$loaded.fails
        $state.alerted = [bool]$loaded.alerted
    } catch { Write-Log "[警告] 狀態檔損毀，重置" }
}

# --- 探測 ---
$publicCode = Get-HttpCode -Url $PublicUrl
$publicOk   = ($publicCode -ge 200 -and $publicCode -lt 400)

if ($publicOk) {
    if ($state.alerted) {
        Send-Alert "✅ linebot 已恢復：公網入口回應 $publicCode，webhook 可正常收訊。" | Out-Null
    } elseif ($state.fails -gt 0) {
        Write-Log "恢復（未達告警門檻，連續失敗 $($state.fails) 次後回復）"
    }
    $state.fails = 0
    $state.alerted = $false
} else {
    $state.fails++
    Write-Log "探測失敗：$PublicUrl → HTTP $publicCode（連續第 $($state.fails) 次）"

    # 達門檻且尚未告警過 → 發一次，避免每 5 分鐘洗版
    if ($state.fails -ge $FailThreshold -and -not $state.alerted) {
        # 順手判斷是「通道掛」還是「整台掛」，通知裡直接給出下一步
        $lanCode = Get-HttpCode -Url $LanHealthUrl -TimeoutSec 6
        $lanOk   = ($lanCode -ge 200 -and $lanCode -lt 400)

        if ($lanOk) {
            $diag = "bot 服務本身正常（區網 /api/health 回 $lanCode），問題在 Cloudflare Tunnel。`n處理：ssh macmini 後 pgrep -fl cloudflared，或 launchctl kickstart -k gui/`$(id -u)/com.cloudflare.cloudflared"
        } else {
            $diag = "區網也連不上（/api/health → $lanCode），可能整台 Mac mini 或 bot 服務都倒了。`n處理：先確認 Mac mini 是否開機。"
        }

        $msg = "⚠️ linebot 對外中斷`n公網 $PublicUrl → HTTP $publicCode`n已連續失敗 $($state.fails) 次（約 $($state.fails * 5) 分鐘）`n`n$diag"
        Send-Alert $msg | Out-Null
        $state.alerted = $true
    }
}

# --- 存狀態 ---
$state | ConvertTo-Json -Compress | Set-Content -Path $StateFile -Encoding UTF8
