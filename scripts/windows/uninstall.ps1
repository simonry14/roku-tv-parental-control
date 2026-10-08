#Requires -Version 5.1
<#
  Roku TV Parental Control: removes it from this PC. Start it with Uninstall.cmd (or from the
  Start menu). It stops and removes the Windows service, the firewall rule and the shortcuts, and
  asks whether to delete your settings and history too. Nothing on the TV is changed.
#>
param(
  [string]$Target = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$Target = (Resolve-Path $Target).Path.TrimEnd('\')
$AppName = 'Roku TV Parental Control'
$ServiceIds = @('rokutvparentalcontrol.exe', 'rokuguardian.exe')
$FirewallRules = @('Roku TV Parental Control dashboard', 'Roku Guardian dashboard')

function Read-YesNo([string]$Question, [bool]$Default) {
  $hint = if ($Default) { '(Y/n)' } else { '(y/N)' }
  while ($true) {
    $answer = (Read-Host "  $Question $hint").Trim().ToLower()
    if ($answer -eq '') { return $Default }
    if ($answer -in @('y', 'yes')) { return $true }
    if ($answer -in @('n', 'no')) { return $false }
    Write-Host '  Please type y or n.'
  }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '  Please start it with Uninstall.cmd, and choose Yes when Windows asks.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host "  Uninstall $AppName" -ForegroundColor White
Write-Host '  The TV goes back to having no limits. Nothing on the TV itself is changed.' -ForegroundColor Gray
if (-not (Read-YesNo "Remove $AppName from this PC?" $false)) {
  Write-Host '  Nothing was removed.'
  exit 0
}

# The Windows service (and any copy still running from this folder).
foreach ($id in $ServiceIds) {
  $svc = Get-Service -Name $id -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne 'Stopped') {
      Stop-Service -Name $id -Force -ErrorAction SilentlyContinue
      try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
    }
    & sc.exe delete $id | Out-Null
    Write-Host "  OK  Removed the Windows service ($id)." -ForegroundColor Green
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($Target.ToLower()) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($f in @('rokutvparentalcontrol', 'rokuguardian')) {
  foreach ($ext in @('.exe', '.exe.config', '.xml')) {
    Remove-Item (Join-Path $Target "service\daemon\$f$ext") -Force -ErrorAction SilentlyContinue
  }
}

# Firewall rule and shortcuts.
foreach ($name in $FirewallRules) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
Write-Host '  OK  Removed the firewall rule.' -ForegroundColor Green
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) "$AppName.url") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $AppName) -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  OK  Removed the shortcuts.' -ForegroundColor Green

# Settings and history.
Write-Host ''
if (Read-YesNo "Also delete your rules, PIN and viewing history (the folder $Target)?" $false) {
  # This window runs from that folder, so a helper deletes it once the window is closed
  # (it tries every 2 seconds for 10 minutes).
  $cmd = "for /l %i in (1,1,300) do @(timeout /t 2 /nobreak >nul & rmdir /s /q ""$Target"" 2>nul & if not exist ""$Target"" exit)"
  Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $cmd) -WindowStyle Hidden
  Write-Host "  OK  $Target will be deleted when you close this window." -ForegroundColor Green
} else {
  Write-Host "  Your settings are kept in $Target, so a reinstall picks them up. Delete that folder to remove them." -ForegroundColor Gray
}

Write-Host ''
Write-Host "  $AppName is removed." -ForegroundColor Green
Write-Host '  On the TV, you can also switch these back if you like:' -ForegroundColor Gray
Write-Host '    Settings > System > Advanced system settings > Control by mobile apps (set by you during setup)' -ForegroundColor Gray
Write-Host '    Developer mode: Home 3 times, Up 2 times, Right, Left, Right, Left, Right > Disable installer' -ForegroundColor Gray
Write-Host '  The PC''s sleep settings were left as they are.' -ForegroundColor Gray
exit 0
