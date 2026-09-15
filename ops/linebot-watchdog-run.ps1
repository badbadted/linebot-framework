# linebot-watchdog-run.ps1
#
# Wrapper layer for the LinebotWatchdog scheduled task, started hidden by
# linebot-watchdog-hidden.vbs.
#
# Purpose:
#   Run linebot-watchdog.ps1 and always leave a trace. The task used to report
#   exit 0 while the watchdog never actually ran - state.json was never written
#   and nothing was logged, so the monitoring looked healthy while being dead.
#   Every run now appends to runner.log, so a silent failure is impossible.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads -File scripts using the
# system codepage unless the file has a UTF-8 BOM; non-ASCII comments in a
# BOM-less file get mangled into parse errors.

$ErrorActionPreference = 'Continue'

$LogDir = Join-Path $env:LOCALAPPDATA 'linebot-watchdog'
$RunLog = Join-Path $LogDir 'runner.log'
$Target = 'C:\Ted\Projects\devtools\linebot-framework\ops\linebot-watchdog.ps1'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function W([string]$m) {
    "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m |
        Add-Content -Path $RunLog -Encoding UTF8
}

$StateFile = Join-Path $LogDir 'state.json'
W "start  LOCALAPPDATA=$env:LOCALAPPDATA  cwd=$((Get-Location).Path)"
W "  target exists=$(Test-Path $Target)  state mtime before=$((Get-Item $StateFile -EA SilentlyContinue).LastWriteTime)"
try {
    $captured = & $Target *>&1 | Out-String
    W "ok (exit=$LASTEXITCODE)"
    if ($captured -and $captured.Trim()) {
        W ("  output: " + ($captured -replace "`r?`n", ' | '))
    } else {
        W "  output: (none)"
    }
} catch {
    W "EXCEPTION $($_.Exception.GetType().Name): $($_.Exception.Message)"
    W ("  at " + ($_.InvocationInfo.PositionMessage -replace "`r?`n", ' | '))
}
W "  state mtime after=$((Get-Item $StateFile -EA SilentlyContinue).LastWriteTime)"

if ((Test-Path $RunLog) -and ((Get-Item $RunLog).Length -gt 512KB)) {
    $keep = Get-Content $RunLog -Encoding UTF8 | Select-Object -Last 1000
    Set-Content -Path $RunLog -Value $keep -Encoding UTF8
}
