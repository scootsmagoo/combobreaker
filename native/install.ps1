<#
.SYNOPSIS
  Registers the ComboBreaker yt-dlp native messaging host for Chrome/Edge/Brave/Chromium.

.DESCRIPTION
  Writes a wrapper .bat and a host manifest under %LOCALAPPDATA%\ComboBreaker\native
  and points the browser's NativeMessagingHosts registry key at it. Safe to re-run;
  re-running with a different -ExtensionId appends to allowed_origins.

  Requirements: Node.js on PATH (or -NodePath), yt-dlp (and ideally ffmpeg) somewhere
  the host can find them. The host looks on PATH and in the usual winget/scoop/pip
  locations, and you can also set explicit paths in ComboBreaker's options page.

.EXAMPLE
  .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
  .\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop -Browser chrome,edge
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  [ValidateSet('chrome', 'chromium', 'edge', 'brave', 'vivaldi')]
  [string[]]$Browser = @('chrome'),

  [string]$NodePath = '',

  [string]$HostName = 'com.combobreaker.ytdlp'
)

$ErrorActionPreference = 'Stop'

function Find-Node {
  if ($NodePath -and (Test-Path $NodePath)) { return (Resolve-Path $NodePath).Path }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "Node.js was not found. Install it (winget install OpenJS.NodeJS.LTS) or pass -NodePath."
}

$hostJs = Join-Path $PSScriptRoot 'host.js'
if (-not (Test-Path $hostJs)) { throw "host.js not found next to this script ($hostJs)." }
$hostJs = (Resolve-Path $hostJs).Path

$node = Find-Node
Write-Host "Node:      $node"
Write-Host "Host:      $hostJs"

$installDir = Join-Path $env:LOCALAPPDATA 'ComboBreaker\native'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Wrapper. Chrome needs a real executable; a .bat that execs node works.
$batPath = Join-Path $installDir 'combobreaker_host.bat'
$bat = "@echo off`r`n`"$node`" `"$hostJs`" %*`r`n"
[System.IO.File]::WriteAllText($batPath, $bat, [System.Text.Encoding]::ASCII)

# Manifest. Merge allowed_origins if one already exists.
$manifestPath = Join-Path $installDir "$HostName.json"
$origin = "chrome-extension://$ExtensionId/"
$origins = @($origin)
if (Test-Path $manifestPath) {
  try {
    $existing = Get-Content $manifestPath -Raw | ConvertFrom-Json
    foreach ($o in $existing.allowed_origins) { if ($o -ne $origin) { $origins += $o } }
  } catch { }
}
$manifest = [ordered]@{
  name            = $HostName
  description     = 'ComboBreaker yt-dlp bridge'
  path            = $batPath
  type            = 'stdio'
  allowed_origins = $origins
}
$json = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Manifest:  $manifestPath"
Write-Host "Origins:   $($origins -join ', ')"

$regRoots = @{
  chrome   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
  chromium = 'HKCU:\Software\Chromium\NativeMessagingHosts'
  edge     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
  brave    = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
  vivaldi  = 'HKCU:\Software\Vivaldi\NativeMessagingHosts'
}
foreach ($b in $Browser) {
  $key = Join-Path $regRoots[$b] $HostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  Write-Host "Registry:  $key"
}

# Tool check (informational; the host does its own lookup at runtime).
Write-Host ''
$ytdlp = Get-Command yt-dlp -ErrorAction SilentlyContinue
if ($ytdlp) { Write-Host "yt-dlp:    $($ytdlp.Source)" }
else {
  $wl = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\yt-dlp.exe'
  if (Test-Path $wl) { Write-Host "yt-dlp:    $wl" }
  else { Write-Warning "yt-dlp not on PATH. Install with:  winget install yt-dlp.yt-dlp" }
}
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) { Write-Host "ffmpeg:    $($ffmpeg.Source)" }
else {
  $wl = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
  if (Test-Path $wl) { Write-Host "ffmpeg:    $wl" }
  else { Write-Warning "ffmpeg not on PATH (needed to merge YouTube video+audio). Install with:  winget install Gyan.FFmpeg" }
}

Write-Host ''
Write-Host 'Done. Fully quit and relaunch the browser, then open ComboBreaker > Media to confirm the bridge is connected.' -ForegroundColor Green
