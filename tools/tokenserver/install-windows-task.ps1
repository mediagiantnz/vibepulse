<#
Registrera tokenservern som en schemalagd uppgift på Windows, så den
överlever utloggning och omstart — luckan i issue #3: tjänsten fanns men
dog med terminalfönstret.

Körs i PowerShell från repots rot:

  powershell -ExecutionPolicy Bypass -File tools\tokenserver\install-windows-task.ps1 `
      -PublishUrl "https://<din-brevlåda>/u/<hemlighet>"

  # utan relä (bara LAN-servering):
  powershell -ExecutionPolicy Bypass -File tools\tokenserver\install-windows-task.ps1

  # med ikon vid klockan (tray-appen äger och övervakar servern):
  powershell -ExecutionPolicy Bypass -File tools\tokenserver\install-windows-task.ps1 `
      -Tray -ServerArgs "--claude-plan","max20x","--codex-plan","pro"

  # avinstallera:
  powershell -ExecutionPolicy Bypass -File tools\tokenserver\install-windows-task.ps1 -Uninstall

Designval, i linje med resten av repot:

- Uppgiften kör som DEN INLOGGADE ANVÄNDAREN, inte SYSTEM. Tokenservern
  läser %USERPROFILE%\.claude\.credentials.json — en SYSTEM-tjänst hade
  läst fel profil och dessutom gett processen mer rättigheter än den
  behöver.
- pythonw.exe (inget konsolfönster). Den nuvarande uppgiften omdirigerar inte
  stdout/stderr till en beständig fil. GET / är hälsokollen; kör servern med
  python.exe i en terminal när en felsökningslogg behövs.
- Interaction providers and detail are read from the tokenserver's saved config.
  Keep those choices out of the scheduled command so setup changes cannot go
  stale here. The optional publish arguments below are numbers-relay settings,
  not interaction-provider choices.
- Ingen hemlighet i den registrerade kommandoraden utom relä-URL:en, som
  användaren själv valt att ge — samma exponeringsnivå som secrets.h.
- Starta om vid fel, var 5:e minut, 255 gånger (Task Scheduler lagrar
  RestartCount som en byte, så 255 är det verkliga taket) - en hyllservice
  ska resa sig själv, precis som launchd-plisten gör på macOS.
- Med -Tray hamnar serverns stderr i
  %LOCALAPPDATA%\VibePulse\Logs\torget-tokenserver.log, som servern själv
  roterar vid 5 MB.
#>
param(
    [string]$PublishUrl = "",
    [string]$PublishName = "",
    [string[]]$ServerArgs = @(),
    [switch]$Tray,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "VibePulse tokenserver"
$TrayTaskName = "VibePulse tray"

# -Tray registers the notification-area app instead of the bare service. The
# tray OWNS the server (it launches tokenserver.py as its child), so exactly
# one of the two tasks may exist: both would race for port 8737 and the loser
# would restart forever. Registering either one therefore retires the other.
function Remove-TaskIfPresent($Name) {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        # Unregistering does not stop a running instance; stop it first so
        # the task registered next is not left fighting it for port 8737.
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "  retired task '$Name'"
        return $true
    }
    return $false
}

if ($Uninstall) {
    $removed = (Remove-TaskIfPresent $TaskName), (Remove-TaskIfPresent $TrayTaskName)
    if (-not ($removed -contains $true)) { Write-Host "Ingen uppgift registrerad." }
    Write-Host "Processen som redan kör påverkas inte;"
    Write-Host "stoppa den via porten:  Get-NetTCPConnection -LocalPort 8737 -State Listen |"
    Write-Host "  Select -Expand OwningProcess | ForEach-Object { Stop-Process -Id `$_ }"
    exit 0
}

# Repots rot är två steg upp från det här skriptet — uppgiften ska
# överleva att den registreras från vilken katalog som helst.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Server = Join-Path $RepoRoot "tools\tokenserver\tokenserver.py"
if (-not (Test-Path $Server)) { throw "hittar inte $Server" }
$TrayApp = Join-Path $RepoRoot "tools\tokenserver\tray_windows.py"
if ($Tray -and -not (Test-Path $TrayApp)) { throw "hittar inte $TrayApp" }

# pythonw = ingen konsol. Faller tillbaka till python.exe om pythonw
# saknas (minimala installationer) — då syns ett fönster, men tjänsten kör.
$Python = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $Python) { $Python = (Get-Command python.exe).Source }

# Check the tray's packages import under the SAME interpreter the task will
# run, before anything is retired. pip may have installed them into a
# different Python than the first pythonw on PATH, and the failure is
# otherwise silent: the old task is gone, the tray dies on `import pystray`,
# no server starts, and the only trace is a line in tray.log.
if ($Tray) {
    $ConsolePython = Join-Path (Split-Path $Python) "python.exe"
    if (-not (Test-Path $ConsolePython)) { $ConsolePython = $Python }
    & $ConsolePython -c "import pystray, PIL" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $Req = Join-Path $RepoRoot "tools\tokenserver\requirements-tray-windows.txt"
        throw ("pystray/Pillow importerar inte under $Python. Installera dem " +
               "i just den Python-installationen och kör igen:`n" +
               "  & `"$ConsolePython`" -m pip install -r `"$Req`"")
    }
}

# The tray forwards everything it does not recognise straight to
# tokenserver.py, so both branches build the same argument tail.
#
# powershell.exe -File cannot pass a real array: written as
# -ServerArgs "--claude-plan","max20x" the whole thing arrives here as the
# SINGLE string "--claude-plan,max20x", and the task then registers it as one
# argument that the server rejects with "unrecognized arguments". Splitting on
# the comma makes both invocation styles work. The cost is that a value which
# legitimately contains a comma cannot be passed this way; nothing the server
# accepts today does. The quotes survive that boundary as literal characters
# too, so each piece is unquoted before it is re-quoted for the task.
$Flat = @()
foreach ($extra in $ServerArgs) {
    foreach ($piece in ($extra -split ',')) {
        $piece = $piece.Trim().Trim('"').Trim("'").Trim()
        if ($piece -ne '') { $Flat += $piece }
    }
}
$Tail = ""
foreach ($extra in $Flat) { $Tail += " `"$extra`"" }
if ($PublishUrl) {
    $Tail += " --publish `"$PublishUrl`""
    if ($PublishName) { $Tail += " --publish-name `"$PublishName`"" }
}

if ($Tray) {
    $RegisterAs = $TrayTaskName
    $Entry = $TrayApp
    Remove-TaskIfPresent $TaskName | Out-Null
} else {
    $RegisterAs = $TaskName
    $Entry = $Server
    Remove-TaskIfPresent $TrayTaskName | Out-Null
}
$Arguments = "`"$Entry`"" + $Tail

# Stopping the old task does not always take its child with it (the tray's
# server is a separate process, and a server started by hand is not a task
# at all). Whatever still listens on 8737 would make the new task's server
# fail to bind, while the tray kept showing the orphan's numbers.
$Orphans = Get-NetTCPConnection -LocalPort 8737 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($OrphanPid in $Orphans) {
    Write-Host "  stoppar process $OrphanPid som lyssnar på 8737"
    Stop-Process -Id $OrphanPid -Force -ErrorAction SilentlyContinue
}

# The working directory is the state folder, not the repo: the service
# resolves its own files from __file__, and a repo-root cwd is where Windows
# would look first for a bare `codex` (see tokenserver._which_not_in_cwd).
$WorkDir = Join-Path $env:LOCALAPPDATA "VibePulse"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$Action = New-ScheduledTaskAction -Execute $Python -Argument $Arguments `
    -WorkingDirectory $WorkDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# RestartCount is stored as an unsigned byte; 255 is the real maximum.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $RegisterAs -Action $Action `
    -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $RegisterAs

Write-Host "Uppgiften '$RegisterAs' registrerad och startad."
if ($Tray) {
    Write-Host "  tray:    $TrayApp  (launches and supervises the server)"
}
Write-Host "  server:  $Server"
# Host only: the path of the relay URL is its secret.
if ($PublishUrl) { Write-Host "  relä:    $(([uri]$PublishUrl).Host)" }
Write-Host "  state:   $env:LOCALAPPDATA\VibePulse\"
if ($Tray) {
    Write-Host "  logg:    $env:LOCALAPPDATA\VibePulse\tray.log"
    Write-Host "           $env:LOCALAPPDATA\VibePulse\Logs\torget-tokenserver.log"
} else {
    Write-Host "  logg:    ingen beständig bakgrundslogg; kör manuellt för felsökning"
}
Write-Host "Verifiera:  curl http://localhost:8737/  (claudeProbe ska visa ok)"
if ($Tray) { Write-Host "            och ikonen vid klockan visar högsta kvot-%" }
