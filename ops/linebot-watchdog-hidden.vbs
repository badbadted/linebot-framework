' Hidden launcher for the LinebotWatchdog scheduled task.
'
' Why this exists (2026-08-06):
'
' 1) No popup.
'    The task runs with LogonType=Interactive, so Task Scheduler starts
'    powershell.exe inside the logged-on desktop session. Windows allocates the
'    console (Windows Terminal on Win11) BEFORE PowerShell can apply
'    -WindowStyle Hidden, so a black console window flashed for ~1s every 5
'    minutes. Launching through wscript.exe (a GUI process, no console) with
'    window style 0 makes Windows create a hidden conhost instead.
'
' 2) It actually runs.
'    Pointing the task at "powershell -File linebot-watchdog.ps1" returned
'    exit 0 without ever executing the script body - state.json was never
'    written and nothing was logged. Going through linebot-watchdog-run.ps1,
'    which invokes the watchdog with the call operator, runs reliably.
'
' The tidier fix would be LogonType=S4U ("run whether user is logged on or
' not"), which runs in session 0 where no window can appear - that needs admin
' rights. This wrapper reaches the same visible result without elevation.
'
' launcher.log is kept bounded: once it passes 512 KB it is cut down to the
' last 1000 lines, the same policy linebot-watchdog-run.ps1 uses for runner.log.

Option Explicit

Const MAX_LOG_BYTES = 524288
Const KEEP_LINES = 1000

Dim sh, fso, q, cmd, rc, logDir, logPath, f
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
logDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\linebot-watchdog"
logPath = logDir & "\launcher.log"

' linebot-watchdog-run.ps1 also creates this folder, but on a fresh install it
' has not run yet, and OpenTextFile fails when the folder is missing.
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
TrimLog logPath

Set f = fso.OpenTextFile(logPath, 8, True)
f.WriteLine Now & "  [VBS] start"
f.Close

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
      q & "C:\Ted\Projects\devtools\linebot-framework\ops\linebot-watchdog-run.ps1" & q

' 0 = hidden window; True = wait, so the task instance lasts as long as the run
' and MultipleInstances=IgnoreNew still prevents overlapping executions.
rc = sh.Run(cmd, 0, True)

Set f = fso.OpenTextFile(logPath, 8, True)
f.WriteLine Now & "  [VBS] powershell rc=" & rc
f.Close

Sub TrimLog(path)
  Dim ts, lines, first, i, out
  If Not fso.FileExists(path) Then Exit Sub
  If fso.GetFile(path).Size <= MAX_LOG_BYTES Then Exit Sub
  Set ts = fso.OpenTextFile(path, 1)
  lines = Split(ts.ReadAll, vbCrLf)
  ts.Close
  first = UBound(lines) - KEEP_LINES
  If first < 0 Then first = 0
  Set out = fso.CreateTextFile(path, True)
  For i = first To UBound(lines)
    ' Split leaves an empty element after the trailing newline; skip empties
    If Len(lines(i)) > 0 Then out.WriteLine lines(i)
  Next
  out.Close
End Sub
