# 在桌面建立「公司文件查詢」捷徑（只需跑一次；搬移資料夾後重跑）
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop '公司文件查詢.lnk'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$here\start-sop-desk.ps1`""
$s.WorkingDirectory = $here
$s.IconLocation = "$here\icon.ico"
$s.Description = '查公司開發規範與 KM 文件'
$s.Save()
Write-Output "已建立：$lnk"
