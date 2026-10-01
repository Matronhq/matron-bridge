<#
.SYNOPSIS
  Register the Matron bridge and file viewer as Scheduled Tasks that start at logon.

.DESCRIPTION
  The Windows counterpart of setup\service-linux.sh (systemd) and
  service-macos.sh (launchd). Two tasks in the \Matron\ folder run
  start-bridge.ps1 (bridge) and start-bridge.ps1 -Viewer (viewer) at logon
  of the current user, in that user's INTERACTIVE desktop session - a Windows
  service would run in Session 0 and could not drive desktop applications
  from a Claude session. They restart on failure (one-minute floor), have no
  execution time limit, and are started immediately.

  Consequence: the bridge runs only while this user is logged on. On an
  unattended box, configure auto-logon.

  Idempotent: re-running replaces the tasks. Not elevated on purpose (a
  per-user task); refuses to run from an elevated prompt so the tasks are not
  registered for the wrong principal.

.PARAMETER Uninstall
  Remove both tasks (stopping them first).
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = Split-Path -Parent $ScriptDir
$TaskPath = '\Matron\'
$Start = Join-Path $RepoDir 'start-bridge.ps1'
$LogDir = Join-Path (Join-Path $env:LOCALAPPDATA 'matron-bridge') 'logs'

function Fail($msg) { Write-Error $msg; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Fail 'Run this from a normal (non-elevated) PowerShell as the user who will run the bridge: the tasks are per-user and run in that user''s desktop session.' }

$tasks = @(
  @{ Name = 'matron-bridge';        Args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Start`"";         Desc = 'Matron Bridge (Claude Code sessions for Matron)' },
  @{ Name = 'matron-bridge-viewer'; Args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Start`" -Viewer"; Desc = 'Matron Bridge file viewer (signed URL file server)' }
)

if ($Uninstall) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Confirm:$false
      Write-Host "Removed $TaskPath$($t.Name)"
    }
  }
  exit 0
}

if (-not (Test-Path (Join-Path $RepoDir '.env'))) { Fail "$RepoDir\.env not found. Run setup\install.ps1 first." }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { Fail 'node.exe not found on PATH.' }

$user = "$env:USERDOMAIN\$env:USERNAME"
Write-Host '=== Installing Scheduled Tasks (at logon, interactive) ==='
Write-Host "Repo: $RepoDir"
Write-Host "User: $user"
Write-Host "Logs: $LogDir"
Write-Host ''

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable

foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $t.Args -WorkingDirectory $RepoDir
  if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Confirm:$false
  }
  Register-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $t.Desc | Out-Null
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $t.Name
  Write-Host "Registered and started $TaskPath$($t.Name)"
}

Start-Sleep -Seconds 3
Write-Host ''
Write-Host 'Status:'
Get-ScheduledTask -TaskPath $TaskPath | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host

Write-Host 'Manage:'
Write-Host "  Status    Get-ScheduledTask -TaskPath '$TaskPath' | Select TaskName, State"
Write-Host '  Restart   .\restart.ps1'
Write-Host "  Logs      Get-Content -Wait '$LogDir\matron-bridge.log'"
Write-Host "  Stop      .\restart.ps1 is start+stop; to stop only: Stop-ScheduledTask -TaskPath '$TaskPath' -TaskName matron-bridge"
Write-Host '  Uninstall setup\service.ps1 -Uninstall'
Write-Host ''
Write-Host 'The tasks run in your desktop session and only while you are logged on; for an unattended box, configure auto-logon.'
