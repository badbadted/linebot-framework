# 公司文件查詢：桌面捷徑叫這支。伺服器沒開就在背景開，再用 Chrome 應用程式視窗打開畫面。
# 伺服器閒置 30 分鐘會自己結束；連點兩次不會開兩個（埠被佔用時新的那個會直接退出）。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:4790/'

function Test-Up {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ($url + 'api/health')).StatusCode -eq 200 } catch { $false }
}

if (-not (Test-Up)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  $log = Join-Path $here '..\..\data\sop-desk\server.log'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
  Start-Process -FilePath $node -ArgumentList @("`"$here\server.mjs`"") -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Up) { break }
  }
}

$browsers = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)
$b = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($b) { Start-Process -FilePath $b -ArgumentList @("--app=$url") } else { Start-Process $url }
