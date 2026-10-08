#Requires -Version 5.1
<#
  Roku TV Parental Control: installer and updater for Windows 10 and 11.

  Start it by double-clicking Install.cmd, which asks Windows for administrator rights first.
  It is safe to run again: an update keeps your rules, PIN, history and settings.

    1. Node.js       installs Node.js LTS if it's missing (winget, or the nodejs.org installer)
    2. Files         copies the app to C:\RokuTVParentalControl (and moves over an older install)
    3. Packages      a source download only: npm ci + npm run build (a release download is prebuilt)
    4. Network       firewall rule for the dashboard (TCP 8090, this network only); offers to mark
                     the Wi-Fi as Private so phones can reach it
    5. Stay awake    offers to stop the PC sleeping while it's plugged in
    6. Setup         the setup wizard: the TV, a PIN, first rules, messages on the TV
    7. Service       runs it as a Windows service that starts with Windows
    8. Shortcuts     desktop + Start menu, then opens the dashboard and shows a QR code for the phone
#>
param(
  [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Target = 'C:\RokuTVParentalControl',
  [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # downloads are much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$AppName = 'Roku TV Parental Control'
$ServiceId = 'rokutvparentalcontrol.exe'
$LegacyServiceIds = @('rokuguardian.exe')
$FirewallRule = 'Roku TV Parental Control dashboard'
$LegacyFirewallRules = @('Roku Guardian dashboard')
$Port = 8090
$MinNodeMajor = 22
$TotalSteps = 8

function Write-Step([int]$Number, [string]$Text) {
  Write-Host ''
  Write-Host "Step $Number of ${TotalSteps}: $Text" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "      $Text" -ForegroundColor Gray }
function Write-Problem([string]$Text) { Write-Host "  !   $Text" -ForegroundColor Yellow }

function Stop-Install([string]$Text) {
  Write-Host ''
  Write-Host "  The installation stopped: $Text" -ForegroundColor Red
  Write-Host '  Nothing on your TV was changed. Fix the problem above, then double-click Install again.'
  Write-Host '  Still stuck? Open an issue on GitHub and paste what this window shows.'
  exit 1
}

function Read-YesNo([string]$Question, [bool]$Default = $true) {
  $hint = if ($Default) { '(Y/n)' } else { '(y/N)' }
  while ($true) {
    $answer = (Read-Host "  $Question $hint").Trim().ToLower()
    if ($answer -eq '') { return $Default }
    if ($answer -in @('y', 'yes')) { return $true }
    if ($answer -in @('n', 'no')) { return $false }
    Write-Host '  Please type y or n.'
  }
}

# ─── Before anything: administrator, Windows version ─────────────────────────

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Stop-Install 'it needs administrator rights. Start it with Install.cmd, and choose Yes when Windows asks.'
}
if ([Environment]::OSVersion.Version.Major -lt 10) { Stop-Install 'it needs Windows 10 or 11.' }

$Source = (Resolve-Path $Source).Path.TrimEnd('\')
$Target = $Target.TrimEnd('\')
$version = (Get-Content (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json).version
$isRelease = Test-Path (Join-Path $Source 'RELEASE')

Write-Host ''
Write-Host "  $AppName $version" -ForegroundColor White
Write-Host '  Screen-time limits, bedtimes and app blocking for your Roku TV.' -ForegroundColor Gray
Write-Host "  It installs into $Target. Takes about 5 minutes." -ForegroundColor Gray

# ─── 1. Node.js ──────────────────────────────────────────────────────────────

function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $default = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $default) { return $default }
  return $null
}

function Get-NodeMajor([string]$NodeExe) {
  try { return [int](& $NodeExe -p "process.versions.node.split('.')[0]") } catch { return 0 }
}

function Install-NodeJs {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Note 'Installing Node.js LTS with winget (Microsoft''s app installer)...'
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    Update-PathFromRegistry
    $node = Get-NodeExe
    if ($node -and (Get-NodeMajor $node) -ge $MinNodeMajor) { return }
  }
  Write-Note 'Downloading Node.js LTS from nodejs.org...'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $release = $index | Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge $MinNodeMajor } | Select-Object -First 1
  if (-not $release) { Stop-Install 'no Node.js download was found. Install Node.js LTS from https://nodejs.org, then run Install again.' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $msi = Join-Path $env:TEMP "node-$($release.version)-$arch.msi"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$($release.version)/node-$($release.version)-$arch.msi" -OutFile $msi -UseBasicParsing
  $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Stop-Install "the Node.js installer failed (code $($p.ExitCode))." }
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  Update-PathFromRegistry
}

Write-Step 1 'Node.js, the engine the app runs on'
$node = Get-NodeExe
if (-not $node -or (Get-NodeMajor $node) -lt $MinNodeMajor) {
  try { Install-NodeJs } catch { Stop-Install "Node.js couldn't be installed: $($_.Exception.Message)" }
  $node = Get-NodeExe
  if (-not $node -or (Get-NodeMajor $node) -lt $MinNodeMajor) {
    Stop-Install "Node.js $MinNodeMajor or newer is needed. Install the LTS version from https://nodejs.org, then run Install again."
  }
}
$npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
Write-Ok "Node.js $(& $node --version)"

# ─── 2. Files ────────────────────────────────────────────────────────────────

# Where an older install (the "Roku Guardian" service) runs from, to bring its settings over.
function Get-ServiceFolder([string]$Id) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$Id'" -ErrorAction SilentlyContinue
  if (-not $svc -or -not $svc.PathName) { return $null }
  if ($svc.PathName -match '^"?([^"]+?\.exe)') {
    # <app>\service\daemon\<id>.exe
    return Split-Path (Split-Path (Split-Path $Matches[1] -Parent) -Parent) -Parent
  }
  return $null
}

function Stop-AppService([string]$Id) {
  $svc = Get-Service -Name $Id -ErrorAction SilentlyContinue
  if (-not $svc -or $svc.Status -eq 'Stopped') { return }
  Stop-Service -Name $Id -Force -ErrorAction SilentlyContinue
  try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
}

# Any copy of the app still running from these folders (npm run dev, an old service).
function Stop-AppProcesses([string[]]$Folders) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    foreach ($f in $Folders) {
      if ($f -and $p.CommandLine -and $p.CommandLine.ToLower().Contains($f.ToLower())) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

Write-Step 2 "Copying the app to $Target"
$legacyFolders = @()
foreach ($id in $LegacyServiceIds) {
  $folder = Get-ServiceFolder $id
  if ($folder) { $legacyFolders += $folder }
}
Stop-AppService $ServiceId
# Installed before from another folder (a developer copy)? Then it moves here.
$currentFolder = Get-ServiceFolder $ServiceId
if ($currentFolder -and $currentFolder.TrimEnd('\') -ne $Target) {
  $legacyFolders += $currentFolder
  & sc.exe delete $ServiceId | Out-Null
  Start-Sleep -Seconds 2
}
foreach ($id in $LegacyServiceIds) {
  if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
    Write-Note "Removing the older service ($id)..."
    Stop-AppService $id
    & sc.exe delete $id | Out-Null
  }
}
Stop-AppProcesses (@($Target, $Source) + $legacyFolders)
Start-Sleep -Seconds 2

New-Item -ItemType Directory -Force -Path $Target | Out-Null
if ($Source -ne $Target) {
  # Your own files are never copied over: config.json, .env, data\ and logs\ stay as they are.
  # node_modules, dist and web\dist are built here from a source download, or mirrored below from a release.
  $skipDirs = @('.git', 'data', 'logs', 'service\daemon', 'roku-channel\out', 'coverage', 'node_modules', 'dist', 'web\dist') |
    ForEach-Object { Join-Path $Source $_ }
  & robocopy.exe $Source $Target /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD $skipDirs /XF config.json .env | Out-Null
  if ($LASTEXITCODE -ge 8) { Stop-Install "copying the files failed (robocopy code $LASTEXITCODE)." }
  if ($isRelease) {
    # The prebuilt parts are mirrored, so nothing stale is left behind from an older version.
    foreach ($dir in @('node_modules', 'dist', 'web\dist')) {
      & robocopy.exe (Join-Path $Source $dir) (Join-Path $Target $dir) /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -ge 8) { Stop-Install "copying $dir failed (robocopy code $LASTEXITCODE)." }
    }
  }
  Write-Ok "Copied version $version."
} else {
  Write-Ok 'Updating in place.'
}

# Bring settings, PIN and history over from an older install, if this one has none yet.
foreach ($from in (@($Source) + $legacyFolders | Select-Object -Unique)) {
  if (-not $from -or $from -eq $Target -or -not (Test-Path $from)) { continue }
  $moved = $false
  foreach ($file in @('config.json', '.env')) {
    if (-not (Test-Path (Join-Path $Target $file)) -and (Test-Path (Join-Path $from $file))) {
      Copy-Item (Join-Path $from $file) (Join-Path $Target $file)
      $moved = $true
    }
  }
  if (-not (Test-Path (Join-Path $Target 'data\roku-guardian.db')) -and (Test-Path (Join-Path $from 'data\roku-guardian.db'))) {
    & robocopy.exe (Join-Path $from 'data') (Join-Path $Target 'data') /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    $moved = $true
  }
  if ($moved) { Write-Ok "Brought your settings and history over from $from" }
}
# Files from the internet are marked "blocked"; unmark the scripts so Windows runs them quietly.
Get-ChildItem -Path $Target -Recurse -Include '*.ps1', '*.cmd' -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# ─── 3. Packages ─────────────────────────────────────────────────────────────

Write-Step 3 'Getting the app ready'
Push-Location $Target
try {
  if ($isRelease) {
    Write-Ok 'This download comes ready to run.'
  } else {
    Write-Note 'Downloading the parts it needs (about 2 minutes)...'
    & $npm ci --no-audit --no-fund '--loglevel=error'
    if ($LASTEXITCODE -ne 0) { Stop-Install 'downloading the parts failed. Check the internet connection, then run Install again.' }
    Write-Note 'Building...'
    & $npm run build --silent
    if ($LASTEXITCODE -ne 0) { Stop-Install 'the build failed (see the messages above).' }
    Write-Ok 'Ready.'
  }
} finally {
  Pop-Location
}
$cli = Join-Path $Target 'dist\src\cli\index.js'
$serviceCli = Join-Path $Target 'dist\src\cli\service.js'
if (-not (Test-Path $cli)) { Stop-Install "$cli is missing." }

# ─── 4. Network ──────────────────────────────────────────────────────────────

Write-Step 4 'Letting phones on your Wi-Fi open the dashboard'
try {
  foreach ($name in @($FirewallRule) + $LegacyFirewallRules) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  New-NetFirewallRule -DisplayName $FirewallRule -Description "$AppName dashboard, for devices on this network only" `
    -Direction Inbound -Protocol TCP -LocalPort $Port -Profile 'Private', 'Domain' -RemoteAddress LocalSubnet -Action Allow | Out-Null
  Write-Ok "Firewall rule added (port $Port, devices on this network only)."
} catch {
  Write-Problem "The firewall rule couldn't be added: $($_.Exception.Message)"
  Write-Note "If your security software has its own firewall, allow incoming TCP port $Port from your home network."
}

$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
foreach ($net in $public) {
  Write-Problem "Windows treats the network ""$($net.Name)"" as Public, which blocks phones from reaching the dashboard."
  Write-Note 'For your home Wi-Fi, Private is the right setting (for a cafe or hotel Wi-Fi, keep Public).'
  if (Read-YesNo "Is ""$($net.Name)"" your home network, and should it be set to Private?" $true) {
    try {
      Set-NetConnectionProfile -InterfaceIndex $net.InterfaceIndex -NetworkCategory Private
      Write-Ok "$($net.Name) is now Private."
    } catch {
      Write-Problem "It couldn't be changed: $($_.Exception.Message)"
      Write-Note 'Change it in Settings > Network & internet > Wi-Fi > (your network) > Private network.'
    }
  }
}

# ─── 5. Stay awake ───────────────────────────────────────────────────────────

Write-Step 5 'Keeping this PC awake'
Write-Note 'The rules only work while this PC is on. The screen can still switch off.'
if (Read-YesNo 'Stop this PC from sleeping while it''s plugged in? (Recommended)' $true) {
  & powercfg.exe /change standby-timeout-ac 0 | Out-Null
  & powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
  if (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue) {
    # A laptop: closing the lid while plugged in no longer puts it to sleep.
    & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
    & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
    Write-Ok 'It stays awake while plugged in, even with the lid closed.'
  } else {
    Write-Ok 'It stays awake.'
  }
} else {
  Write-Note 'Left as it is. While the PC sleeps, the rules aren''t applied.'
}

# ─── 6. Setup ────────────────────────────────────────────────────────────────

Write-Step 6 'Setting up your TV, PIN and rules'
if ($SkipSetup) {
  Write-Note 'Skipped (-SkipSetup).'
} else {
  & $node $cli setup --installer
  if ($LASTEXITCODE -eq 130) { Stop-Install 'setup was stopped. Run Install again to finish it.' }
  if ($LASTEXITCODE -ne 0) { Stop-Install 'setup didn''t finish (see above).' }
}

# ─── 7. Service ──────────────────────────────────────────────────────────────

Write-Step 7 'Starting it, now and whenever Windows starts'
& $node $serviceCli ensure
if ($LASTEXITCODE -ne 0) { Stop-Install 'the Windows service could not be set up (see above).' }
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 3
    $up = $r.StatusCode -eq 200
  } catch {
    Start-Sleep -Seconds 3
  }
}
if ($up) {
  Write-Ok "$AppName is running."
} else {
  Write-Problem 'It hasn''t answered yet. It may still be starting. If the dashboard doesn''t open,'
  Write-Note "look at $Target\logs\service\launcher.log, or restart the PC."
}

# ─── 8. Shortcuts ────────────────────────────────────────────────────────────

Write-Step 8 'Adding shortcuts'
$icon = Join-Path $Target 'scripts\windows\app.ico'
$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$menu = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $AppName
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$link = "[InternetShortcut]`r`nURL=http://localhost:$Port/`r`nIconFile=$icon`r`nIconIndex=0`r`n"
foreach ($folder in @($desktop, $menu)) {
  Set-Content -Path (Join-Path $folder "$AppName.url") -Value $link -Encoding ASCII
}
$shell = New-Object -ComObject WScript.Shell
$phone = $shell.CreateShortcut((Join-Path $menu 'Open it on a phone.lnk'))
$phone.TargetPath = $env:ComSpec
$phone.Arguments = "/k ""title $AppName && ""$node"" ""$cli"" phone"""
$phone.WorkingDirectory = $Target
$phone.IconLocation = $icon
$phone.Save()
$again = $shell.CreateShortcut((Join-Path $menu 'Run setup again.lnk'))
$again.TargetPath = Join-Path $Target 'Install.cmd'
$again.WorkingDirectory = $Target
$again.Description = 'Change the TV, the PIN or the messages on the TV. Your rules and history are kept.'
$again.IconLocation = $icon
$again.Save()
$uninstall = $shell.CreateShortcut((Join-Path $menu "Uninstall $AppName.lnk"))
$uninstall.TargetPath = Join-Path $Target 'Uninstall.cmd'
$uninstall.WorkingDirectory = $Target
$uninstall.Save()
Write-Ok "On the desktop and in the Start menu: ""$AppName""."

# ─── Done ────────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host "  All done. $AppName is looking after the TV." -ForegroundColor Green
# Through Explorer, so the browser opens as you rather than as administrator.
if ($up) { Start-Process -FilePath explorer.exe -ArgumentList "http://localhost:$Port/" }
& $node $cli phone
Write-Host '  Sign in with the PIN you chose. To change the rules any time, use the dashboard.'
Write-Host "  To update later, download the new version and run its Install.cmd: your settings are kept."
Write-Host "  To change the TV or the PIN: Start menu > $AppName > Run setup again."
exit 0
