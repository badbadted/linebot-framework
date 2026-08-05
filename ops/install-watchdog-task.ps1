# install-watchdog-task.ps1
# 把 linebot-watchdog.ps1 註冊成 Windows 排程工作（每 5 分鐘一次）。
# 以目前使用者身分執行、登入後才跑，因此不需要儲存密碼、不需要系統管理員權限。
#
# 註：這裡用 schtasks.exe 而非 Register-ScheduledTask。後者的 -RepetitionDuration
#     不接受「無限期」（TimeSpan::MaxValue 與 Zero 都會被 XML 驗證擋掉），
#     schtasks 的 /SC MINUTE /MO 5 天生就是無限重複，乾淨得多。
#
# 移除：schtasks /Delete /TN LinebotWatchdog /F

$ErrorActionPreference = 'Stop'

$TaskName   = 'LinebotWatchdog'
$ScriptPath = Join-Path $PSScriptRoot 'linebot-watchdog.ps1'

if (-not (Test-Path $ScriptPath)) { throw "找不到 $ScriptPath" }

$run = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden ' +
       "-ExecutionPolicy Bypass -File \`"$ScriptPath\`""

& schtasks.exe /Create /TN $TaskName /TR $run /SC MINUTE /MO 5 /F
if ($LASTEXITCODE -ne 0) { throw "schtasks 註冊失敗（exit $LASTEXITCODE）" }

Write-Host "已註冊排程工作：$TaskName（每 5 分鐘）"
Write-Host "手動觸發一次：schtasks /Run /TN $TaskName"
Write-Host "查看狀態：    schtasks /Query /TN $TaskName /V /FO LIST"
