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

Option Explicit

Dim sh, fso, q, cmd, rc, logPath, f
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
logPath = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\linebot-watchdog\launcher.log"

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
