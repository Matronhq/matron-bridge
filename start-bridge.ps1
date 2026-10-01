<#
.SYNOPSIS
  Run the Matron bridge (or the file viewer) in the foreground with logs.

.DESCRIPTION
  The Windows counterpart of start-bridge.sh and the body of the Scheduled
  Tasks that setup\service.ps1 registers. It checks the prerequisites, rotates
  the log and runs node on the absolute index.js path (restart.ps1 finds the
  process by that command line), redirecting output to
  %LOCALAPPDATA%\matron-bridge\logs\. It exits with node's exit code so the
  task's restart-on-failure fires on a crash and stays quiet on a clean exit.

  index.js loads .env itself (dotenv), so no environment inlining is needed:
  edit .env, then .\restart.ps1.

.PARAMETER Viewer
  Run viewer\start.js instead of index.js.
#>
[CmdletBinding()]
param(
  [switch]$Viewer
)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoDir

$Name = if ($Viewer) { 'matron-bridge-viewer' } else { 'matron-bridge' }
$Entry = if ($Viewer) { Join-Path $RepoDir 'viewer\start.js' } else { Join-Path $RepoDir 'index.js' }

$StateDir = Join-Path $env:LOCALAPPDATA 'matron-bridge'
$LogDir = Join-Path $StateDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Fail($msg) { Write-Error $msg; exit 1 }

if (-not (Test-Path (Join-Path $RepoDir '.env'))) { Fail "No .env in $RepoDir. Run setup\install.ps1 (or npm run setup) first." }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail 'node.exe not found on PATH. Install Node.js 22+ (winget install OpenJS.NodeJS.LTS) and open a new terminal.' }
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node.js 22+ is required (found $(& $node.Source --version))." }
if (-not $Viewer -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'claude not found on PATH: sessions will fail to spawn until Claude Code is installed (irm https://claude.ai/install.ps1 | iex).'
}

# Rotate: keep the last 5 runs.
$Log = Join-Path $LogDir "$Name.log"
$ErrLog = Join-Path $LogDir "$Name.err.log"
foreach ($f in @($Log, $ErrLog)) {
  for ($i = 4; $i -ge 1; $i--) {
    if (Test-Path "$f.$i") { Move-Item -Force "$f.$i" "$f.$($i + 1)" }
  }
  if (Test-Path $f) { Move-Item -Force $f "$f.1" }
}

# ELECTRON_RUN_AS_NODE unset, as the systemd unit does.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# stdout goes straight to the (freshly rotated) log so `Get-Content -Wait`
# follows it live; stderr to its own file. Start-Process truncates both.
$proc = Start-Process -FilePath $node.Source -ArgumentList @("`"$Entry`"") -WorkingDirectory $RepoDir `
  -NoNewWindow -PassThru -Wait -RedirectStandardOutput $Log -RedirectStandardError $ErrLog
"[start-bridge] $(Get-Date -Format o) $Name exited with code $($proc.ExitCode)" | Out-File -FilePath $ErrLog -Append -Encoding utf8
exit $proc.ExitCode
