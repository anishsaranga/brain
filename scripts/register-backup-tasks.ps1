<#
.SYNOPSIS
  Install the two scheduled tasks that run brain's backups.

.DESCRIPTION
  Creates (or updates) two Windows scheduled tasks under \brain\:

    brain-export-json   nightly  - the primary, portable backup. No downtime.
    brain-dump          monthly  - byte-exact, stops Neo4j for ~30 seconds.

  Both run as the current user, so no elevation is needed. They are configured
  to run only when the user is logged on, which is not a limitation so much as
  an acknowledgement: Docker Desktop on this box is a GUI app that only starts
  on an interactive login, so a task running at the lock screen would find no
  engine anyway. The scripts log that case clearly, and /api/health reports
  staleness if a run of them is missed.

.EXAMPLE
  powershell -File scripts/register-backup-tasks.ps1
  powershell -File scripts/register-backup-tasks.ps1 -NightlyAt 03:30 -Unregister
#>
[CmdletBinding()]
param(
  [string]$NightlyAt  = "04:00",
  [string]$MonthlyAt  = "04:30",
  [int]$MonthlyDay    = 1,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$folder = "\brain\"

$tasks = @(
  @{ Name = "brain-export-json"; Description = "brain: nightly portable JSON + markdown export" },
  @{ Name = "brain-dump";        Description = "brain: monthly neo4j-admin dump (brief downtime)" }
)

if ($Unregister) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t.Name -TaskPath $folder -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t.Name -TaskPath $folder -Confirm:$false
      Write-Host "removed $($t.Name)"
    }
  }
  exit 0
}

if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  throw "Run this from the brain repo; $projectRoot does not look like it."
}

# npm is a .cmd shim, so the action has to go through cmd.exe rather than
# invoking npm directly - Task Scheduler does not resolve PATHEXT.
function New-NpmAction([string]$npmScript) {
  New-ScheduledTaskAction -Execute "cmd.exe" `
    -Argument "/c npm run $npmScript >> `"$projectRoot\backups\scheduled.log`" 2>&1" `
    -WorkingDirectory $projectRoot
}

function New-PwshAction([string]$scriptFile) {
  New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$projectRoot\scripts\$scriptFile`"" `
    -WorkingDirectory $projectRoot
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

# -StartWhenAvailable matters: if the machine was asleep at 04:00, run the
# backup when it next wakes rather than skipping that night entirely.

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# ── Nightly: JSON then markdown ──────────────────────────────────────────────
$nightly = New-ScheduledTask `
  -Action @((New-NpmAction "export:json"), (New-NpmAction "export:md")) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $NightlyAt) `
  -Settings $settings `
  -Principal $principal `
  -Description $tasks[0].Description

Register-ScheduledTask -TaskName $tasks[0].Name -TaskPath $folder -InputObject $nightly -Force | Out-Null
Write-Host "registered $($tasks[0].Name) - daily at $NightlyAt"

# ── Monthly: the dump ────────────────────────────────────────────────────────
$monthlyTrigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 `
  -DaysOfWeek Sunday -At $MonthlyAt

$monthly = New-ScheduledTask `
  -Action (New-PwshAction "dump.ps1") `
  -Trigger $monthlyTrigger `
  -Settings $settings `
  -Principal $principal `
  -Description $tasks[1].Description

Register-ScheduledTask -TaskName $tasks[1].Name -TaskPath $folder -InputObject $monthly -Force | Out-Null
Write-Host "registered $($tasks[1].Name) - every 4 weeks, Sunday at $MonthlyAt"

Write-Host ""
Write-Host "Verify with:  Get-ScheduledTask -TaskPath '\brain\'"
Write-Host "Run one now:  Start-ScheduledTask -TaskName 'brain-export-json' -TaskPath '\brain\'"
Write-Host "Logs:         $projectRoot\backups\scheduled.log"
Write-Host "Freshness:    curl -s http://127.0.0.1:9999/api/health"
