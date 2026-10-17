<#
.SYNOPSIS
  Generate the MCP credentials and write them into .env, without printing them.

.DESCRIPTION
  Two secrets guard /mcp: MCP_PATH_SECRET (the path segment) and
  MCP_BEARER_TOKEN (the header). Both are rotated the same way, and both want
  the same handling: generated with a CSPRNG, written straight into .env, and
  never echoed into a terminal scrollback or a chat transcript that outlives
  them. That is the whole reason this script exists instead of a line of
  instructions saying "run openssl and paste the result" — openssl is not on
  PATH here anyway, and a pasted secret is a secret you can no longer account
  for.

  -Show is the one exception: you cannot put the values into the claude.ai
  connector dialog without seeing them once. Run it at the moment you are
  pasting, not before.

  Encoding is handled explicitly. Windows PowerShell 5.1 reads with
  Get-Content as ANSI and writes with Set-Content as ANSI, which has silently
  corrupted em-dashes in files on this box before; this uses .NET UTF-8 with
  no BOM on both sides. A dotenv parser that meets a BOM treats it as part of
  the first key name, so the BOM matters as much as the dashes.

  ROTATING THE PATH SECRET CHANGES THE CONNECTOR URL. The existing connector
  in claude.ai stops working the moment brain-web is recreated, and stays
  broken until you paste the new URL in. That is expected; do not debug it.

.EXAMPLE
  # Rotate both, then recreate the container:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1
  docker compose up -d --build brain-web

.EXAMPLE
  # When you are ready to paste into the connector dialog:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1 -Show

.EXAMPLE
  # Rotate only the token, leaving the URL (and the connector) alone:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1 -TokenOnly
#>
[CmdletBinding()]
param(
  [string]$EnvFile = ".env",
  # Print the current values instead of generating new ones.
  [switch]$Show,
  # Leave MCP_PATH_SECRET alone; the connector URL keeps working.
  [switch]$TokenOnly
)

$ErrorActionPreference = "Stop"

# Run from the repo root regardless of where the caller's prompt is.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path $EnvFile)) {
  Write-Error "$EnvFile not found. Copy .env.example to .env first."
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$path = (Resolve-Path $EnvFile).Path
$lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)

function Get-EnvValue([string[]]$Lines, [string]$Key) {
  foreach ($line in $Lines) {
    if ($line -match "^$([regex]::Escape($Key))=(.*)$") { return $Matches[1].Trim() }
  }
  return $null
}

if ($Show) {
  Write-Host ""
  Write-Host "  Paste these now, then clear your terminal." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Connector URL:"
  Write-Host "    https://<your-hostname>/mcp/$(Get-EnvValue $lines 'MCP_PATH_SECRET')"
  Write-Host ""
  Write-Host "  Request header (either name works):"
  Write-Host "    Authorization: Bearer $(Get-EnvValue $lines 'MCP_BEARER_TOKEN')"
  Write-Host "    X-Brain-Token: $(Get-EnvValue $lines 'MCP_BEARER_TOKEN')"
  Write-Host ""
  exit 0
}

function New-HexSecret([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  # RandomNumberGenerator, not Get-Random: Get-Random is a seeded PRNG and is
  # documented as unsuitable for cryptographic use.
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  # [Convert]::ToHexString is .NET 5+; this box runs Windows PowerShell 5.1.
  return (-join ($buffer | ForEach-Object { $_.ToString("x2") }))
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$path.bak-$stamp"
$n = 1
while (Test-Path $backup) { $backup = "$path.bak-$stamp-$n"; $n++ }
Copy-Item $path $backup
Write-Host "  backup          : $(Split-Path -Leaf $backup)"

$newPath  = if ($TokenOnly) { $null } else { New-HexSecret 24 }
$newToken = New-HexSecret 32

$sawPath = $false
$sawToken = $false
$out = foreach ($line in $lines) {
  if (-not $TokenOnly -and $line -match "^MCP_PATH_SECRET=") {
    $sawPath = $true; "MCP_PATH_SECRET=$newPath"
  }
  elseif ($line -match "^#?\s*MCP_BEARER_TOKEN=") {
    $sawToken = $true; "MCP_BEARER_TOKEN=$newToken"
  }
  else { $line }
}
$out = @($out)

if (-not $TokenOnly -and -not $sawPath) {
  Remove-Item $backup
  Write-Error "No MCP_PATH_SECRET line in $EnvFile. Refusing to guess where it belongs."
}

if (-not $sawToken) {
  # Insert directly after the path secret, so the two live together.
  $i = [array]::FindIndex($out, [Predicate[string]] { param($l) $l -match "^MCP_PATH_SECRET=" })
  if ($i -lt 0) { $i = $out.Count - 1 }
  $insert = @("", "# Bearer token for /mcp. See .env.example for the three modes.", "MCP_BEARER_TOKEN=$newToken", "#MCP_REQUIRE_TOKEN=1")
  $out = @($out[0..$i]) + $insert + @($out[($i + 1)..($out.Count - 1)])
}

[System.IO.File]::WriteAllLines($path, $out, $utf8NoBom)

# Verify by reading back. Report shape only — never a value.
$after = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
$pathLen  = (Get-EnvValue $after 'MCP_PATH_SECRET').Length
$tokenLen = (Get-EnvValue $after 'MCP_BEARER_TOKEN').Length
$requires = ($after | Where-Object { $_ -match "^MCP_REQUIRE_TOKEN=" }).Count -gt 0

Write-Host "  MCP_PATH_SECRET : $pathLen hex chars$(if ($TokenOnly) { ' (unchanged)' } else { ' (rotated)' })"
Write-Host "  MCP_BEARER_TOKEN: $tokenLen hex chars (new)"
Write-Host "  MCP_REQUIRE_TOKEN: $(if ($requires) { 'SET - enforcing' } else { 'not set - permissive, as intended' })"

$bad = $false
if ($pathLen -ne 48)  { Write-Host "  MCP_PATH_SECRET is not 48 chars" -ForegroundColor Red; $bad = $true }
if ($tokenLen -ne 64) { Write-Host "  MCP_BEARER_TOKEN is not 64 chars" -ForegroundColor Red; $bad = $true }
foreach ($key in @("NEO4J_PASSWORD", "AUTH_SECRET", "ADMIN_USERNAME", "PUBLIC_BASE_URL")) {
  if ((Get-EnvValue $after $key) -ne (Get-EnvValue $lines $key)) {
    Write-Host "  $key changed, which it should not have" -ForegroundColor Red; $bad = $true
  }
}
if ($bad) {
  Write-Host ""
  Write-Host "  Something is wrong. Restore with:" -ForegroundColor Red
  Write-Host "    Copy-Item '$backup' '$path' -Force"
  exit 1
}

Write-Host ""
Write-Host "  Next:" -ForegroundColor Cyan
Write-Host "    docker compose up -d --build brain-web"
if (-not $TokenOnly) {
  Write-Host "    ...then update the connector URL in claude.ai - it is broken until you do."
}
Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotate-mcp-secrets.ps1 -Show   # when pasting"
Write-Host ""
