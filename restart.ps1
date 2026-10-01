<#
.SYNOPSIS
  Restart the Matron bridge on Windows.

.DESCRIPTION
  The counterpart of restart.sh. Stops the running bridge gracefully through
  its loopback POST /shutdown (the bridge kills its sessions and flushes the
  journal outbox, then exits 0 - see lib/shutdown-endpoint.js), falls back to
  a forced process-tree kill of anything still holding the API port or
  running this checkout's index.js, and starts it again: through the
  Scheduled Task when setup\service.ps1 installed one, otherwise detached
  from this console (the nohup equivalent).

.PARAMETER DelaySeconds
  Wait this long first, in a detached PowerShell, then restart. This is how
  deploy.ps1 restarts from inside a bridge session: the caller is a
  descendant of the bridge about to be stopped, so the restart must outlive it.

.PARAMETER Port
  The bridge API port (default: MATRON_BRIDGE_API_PORT from .env, else 9802).
#>
[CmdletBinding()]
param(
  [int]$DelaySeconds = 0,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir
$TaskPath = '\Matron\'
$TaskName = 'matron-bridge'
$IndexJs = Join-Path $RepoDir 'index.js'
$StateDir = Join-Path $env:LOCALAPPDATA 'matron-bridge'
$TokenFile = Join-Path $StateDir 'shutdown.token'
$LogDir = Join-Path $StateDir 'logs'

if ($DelaySeconds -gt 0) {
  # Detach: a fresh hidden PowerShell that survives the bridge (and whatever
  # session invoked us) going away.
  $self = $MyInvocation.MyCommand.Path
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Start-Sleep -Seconds $DelaySeconds; & '$self' -Port $Port"
  ) | Out-Null
  Write-Host "Restart scheduled in $DelaySeconds s (detached)."
  exit 0
}

# Port from .env when not given.
if ($Port -le 0) {
  $Port = 9802
  $envFile = Join-Path $RepoDir '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^MATRON_BRIDGE_API_PORT=(\d+)' | Select-Object -First 1
    if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
  }
}

function Get-BridgeProcesses {
  # Anything running THIS checkout's index.js (start-bridge.ps1 passes the
  # absolute path), plus whatever holds the API port.
  $pids = @()
  $escaped = [regex]::Escape($IndexJs)
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $escaped } | ForEach-Object { $pids += $_.ProcessId }
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $pids += $_.OwningProcess }
  $pids | Where-Object { $_ -gt 0 } | Sort-Object -Unique
}

function Wait-PortFree([int]$seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host 'Stopping the bridge...'
# 1. Graceful: POST /shutdown with the per-boot token.
$graceful = $false
if ((Test-Path $TokenFile) -and (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  $token = (Get-Content -Raw $TokenFile).Trim()
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$Port/shutdown" `
      -Headers @{ 'X-Matron-Shutdown-Token' = $token } -TimeoutSec 5
    if ($resp.StatusCode -eq 202) {
      Write-Host '  shutdown accepted; waiting for the port to be released...'
      $graceful = Wait-PortFree 20
    } else {
      Write-Host "  /shutdown answered $($resp.StatusCode)"
    }
  } catch {
    Write-Host "  /shutdown failed: $($_.Exception.Message)"
  }
}
if (-not $graceful) {
  # 2. Forced: the task (Task Scheduler ends its process tree), then anything left.
  if ($task) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
  foreach ($procId in (Get-BridgeProcesses)) {
    Write-Host "  killing process tree $procId"
    & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
  }
  if (-not (Wait-PortFree 10)) {
    Write-Error "Port $Port is still in use after cleanup:"
    Get-NetTCPConnection -LocalPort $Port -State Listen | Format-Table -AutoSize | Out-String | Write-Host
    exit 1
  }
}

Write-Host 'Starting the bridge...'
if ($task) {
  # The task is MultipleInstances=IgnoreNew: a start request while the old
  # instance's PowerShell host is still winding down would be dropped.
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 500
  }
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
  Start-Sleep -Seconds 3
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
  Write-Host "  task $TaskPath$TaskName last result: $($info.LastTaskResult) (0 = running or exited clean)"
  Write-Host "  logs: $LogDir\matron-bridge.log"
} else {
  $start = Join-Path $RepoDir 'start-bridge.ps1'
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$start`"") | Out-Null
  Start-Sleep -Seconds 2
  $running = Get-BridgeProcesses
  if ($running) {
    Write-Host "  bridge started (PID $($running -join ', ')); logs: $LogDir\matron-bridge.log"
  } else {
    Write-Error "The bridge did not start. Check $LogDir\matron-bridge.err.log"
    exit 1
  }
}
