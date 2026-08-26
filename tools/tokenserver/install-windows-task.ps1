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
- Starta om vid fel, var 5:e minut, utan tak — en hyllservice ska resa
  sig själv, precis som launchd-plisten gör på macOS.
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

# The tray forwards everything it does not recognise straight to
# tokenserver.py, so both branches build the same argument tail.
$Tail = ""
foreach ($extra in $ServerArgs) { $Tail += " `"$extra`"" }
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

$Action = New-ScheduledTaskAction -Execute $Python -Argument $Arguments `
    -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $RegisterAs -Action $Action `
    -Trigger $Trigger -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $RegisterAs

Write-Host "Uppgiften '$RegisterAs' registrerad och startad."
if ($Tray) {
    Write-Host "  tray:    $TrayApp  (launches and supervises the server)"
    Write-Host "  deps:    pip install -r requirements-tray-windows.txt"
}
Write-Host "  server:  $Server"
if ($PublishUrl) { Write-Host "  relä:    $PublishUrl" }
Write-Host "  state:   $env:LOCALAPPDATA\VibePulse\"
Write-Host "  logg:    ingen beständig bakgrundslogg; kör manuellt för felsökning"
Write-Host "Verifiera:  curl http://localhost:8737/  (claudeProbe ska visa ok)"
if ($Tray) { Write-Host "            och ikonen vid klockan visar högsta kvot-%" }
