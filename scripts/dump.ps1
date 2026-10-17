<#
.SYNOPSIS
  Tier 2 backup: a byte-exact neo4j-admin dump. Monthly.

.DESCRIPTION
  `neo4j-admin database dump` says it in its own help text: "It is not possible
  to dump a database that is mounted in a running Neo4j server." Online backup
  (`neo4j-admin database backup`) is Enterprise-only. So on Community every
  dump costs downtime, which is why this runs monthly while the JSON export —
  the primary, portable backup — runs nightly with none.

  The risk this script manages is obvious and serious: it stops the database.
  If it then dies, the service stays down until somebody notices. So the
  restart is in a finally block, and the script verifies health before exiting
  non-zero for any other reason.

  Only the `neo4j` database is dumped, not `system`. On Community `system`
  holds little beyond the single user's password, and restoring a stale one is
  a confusing failure rather than a useful recovery.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dump.ps1
#>
[CmdletBinding()]
param(
  [string]$Image      = "neo4j:2026.09.0",
  [string]$Volume     = "brain_brain-neo4j-data",
  [string]$Service    = "brain-neo4j",
  [string]$BackupDir  = "./backups",
  [int]$Keep          = 3
)

$ErrorActionPreference = "Stop"
$started   = Get-Date
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$backupPath = (New-Item -ItemType Directory -Force -Path $BackupDir).FullName
$stamp      = Get-Date -Format "yyyy-MM-dd"
$finalName  = "brain-$stamp.dump"
$runRecord  = Join-Path $backupPath "last-run-dump.json"

function Write-Run([bool]$ok, [string]$detail) {
  $record = [ordered]@{
    name = "dump"
    at   = (Get-Date).ToString("o")
    ok   = $ok
    detail = $detail
    ms   = [int]((Get-Date) - $started).TotalMilliseconds
  }
  $record | ConvertTo-Json | Set-Content -Path $runRecord -Encoding utf8
}

# Docker Desktop here is a GUI app that only starts on an interactive login, so
# a scheduled run WILL sometimes find no engine. That is an expected condition
# to state plainly, not a stack trace to decode weeks later.
try { docker info *> $null } catch { }
if ($LASTEXITCODE -ne 0) {
  $msg = "Docker is not running. Scheduled runs find this after an unattended " +
         "reboot, because Docker Desktop needs an interactive login. See SERVICES-RUNBOOK.md."
  Write-Host "[dump] FAILED: $msg"
  Write-Run $false $msg
  exit 1
}

$stopped = $false
$failure = $null
try {
  Write-Host "[dump] stopping $Service"
  docker compose stop $Service | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not stop $Service" }
  $stopped = $true

  Write-Host "[dump] dumping (database offline)"
  docker run --rm `
    -v "${Volume}:/data" `
    -v "${backupPath}:/backups" `
    $Image `
    neo4j-admin database dump neo4j --to-path=/backups --overwrite-destination | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "neo4j-admin database dump failed" }
}
catch {
  # Catch rather than let it propagate: an uncaught throw skips the run record,
  # so a failed dump would leave no trace at all and look identical to a run
  # that never happened.
  $failure = $_.Exception.Message
  Write-Host "[dump] FAILED: $failure"
}
finally {
  # Unconditional. A dump failure is recoverable; leaving the knowledge base
  # offline because the script threw is not.
  if ($stopped) {
    Write-Host "[dump] restarting $Service"
    docker compose start $Service | Out-Null
  }
}

if ($failure) {
  Write-Run $false $failure
  exit 1
}

# neo4j-admin names the file after the database; date it so rotation can work.
$produced = Join-Path $backupPath "neo4j.dump"
if (-not (Test-Path $produced)) {
  $msg = "dump reported success but $produced does not exist"
  Write-Host "[dump] FAILED: $msg"
  Write-Run $false $msg
  exit 1
}
$target = Join-Path $backupPath $finalName
Move-Item -Force -Path $produced -Destination $target

# Rotation. Only ever touches files matching this script's own naming pattern —
# a pruner that can delete something it did not write is its own disaster.
$old = Get-ChildItem -Path $backupPath -Filter "brain-*.dump" |
       Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($f in $old) {
  Write-Host "[dump] pruning $($f.Name)"
  Remove-Item -Force $f.FullName
}

# Verify the WHOLE stack came back before calling this a success.
#
# brain-web is included deliberately: stopping Neo4j fails its healthcheck, so
# it goes unhealthy during every dump. It recovers on its own once the driver
# reconnects (measured: ~20s), but a monthly task that reports success while
# the user-facing tier is still down would hide a real outage on the one night
# nobody is watching.
$waitFor = @($Service, "brain-web")
$unhealthy = @()
foreach ($name in $waitFor) {
  $ok = $false
  foreach ($i in 1..30) {
    $state = (docker inspect $name --format '{{.State.Health.Status}}' 2>$null)
    if ($state -eq "healthy") { $ok = $true; break }
    Start-Sleep -Seconds 5
  }
  if (-not $ok) { $unhealthy += $name }
}

$size = "{0:N1} MB" -f ((Get-Item $target).Length / 1MB)
if ($unhealthy.Count -gt 0) {
  $msg = "dump written to $finalName ($size) BUT these did not return to healthy: " +
         ($unhealthy -join ", ") + ". Check them now."
  Write-Host "[dump] WARNING: $msg"
  Write-Run $false $msg
  exit 1
}

Write-Host "[dump] ok - $finalName ($size), stack healthy"
Write-Run $true "$finalName ($size)"
exit 0
