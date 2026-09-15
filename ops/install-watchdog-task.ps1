# install-watchdog-task.ps1
# 把 watchdog 註冊成 Windows 排程工作（每 5 分鐘一次）。
# 以目前使用者身分執行、登入後才跑，因此不需要儲存密碼、不需要系統管理員權限。
#
# 排程不直接執行 linebot-watchdog.ps1，而是：
#   wscript.exe → linebot-watchdog-hidden.vbs → linebot-watchdog-run.ps1 → linebot-watchdog.ps1
# 直接用 powershell -File 會每 5 分鐘閃一次黑色視窗，而且曾回報 exit 0 卻沒真的執行，
# 原因詳見 linebot-watchdog-hidden.vbs 開頭註解。
#
# 註：這裡用 schtasks.exe 而非 Register-ScheduledTask。後者的 -RepetitionDuration
#     不接受「無限期」（TimeSpan::MaxValue 與 Zero 都會被 XML 驗證擋掉），
#     schtasks 的 /SC MINUTE /MO 5 天生就是無限重複，乾淨得多。
#
# 移除：schtasks /Delete /TN LinebotWatchdog /F

$ErrorActionPreference = 'Stop'

$TaskName   = 'LinebotWatchdog'
$ScriptPath = Join-Path $PSScriptRoot 'linebot-watchdog-hidden.vbs'

foreach ($name in 'linebot-watchdog-hidden.vbs', 'linebot-watchdog-run.ps1', 'linebot-watchdog.ps1') {
    $p = Join-Path $PSScriptRoot $name
    if (-not (Test-Path $p)) { throw "找不到 $p" }
}

$run = "$env:SystemRoot\System32\wscript.exe \`"$ScriptPath\`""

& schtasks.exe /Create /TN $TaskName /TR $run /SC MINUTE /MO 5 /F
if ($LASTEXITCODE -ne 0) { throw "schtasks 註冊失敗（exit $LASTEXITCODE）" }

Write-Host "已註冊排程工作：$TaskName（每 5 分鐘）"
Write-Host "手動觸發一次：schtasks /Run /TN $TaskName"
Write-Host "查看狀態：    schtasks /Query /TN $TaskName /V /FO LIST"
