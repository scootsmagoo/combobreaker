<#
.SYNOPSIS
  One-shot installer for the ComboBreaker video download helper (Windows).

.DESCRIPTION
  Meant to be run straight from the command ComboBreaker's Setup page shows:

    powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((curl.exe -fsSL <raw url>/native/setup.ps1 | Out-String))) -ExtensionId <id>"

  It does everything, and is safe to re-run:
    1. installs yt-dlp, ffmpeg and Node.js with winget if they are missing
    2. puts the helper (host.js) in %LOCALAPPDATA%\ComboBreaker\native
    3. registers it with Chrome, Edge, Brave, Chromium and Vivaldi

  Nothing is installed system-wide and no admin rights are needed.
  Remove everything again with native\uninstall.ps1.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,

  # Where host.js is fetched from when this script is not sitting next to it.
  [string]$Source = 'https://raw.githubusercontent.com/scootsmagoo/combobreaker/main/native',

  [string]$HostName = 'com.combobreaker.ytdlp'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Find-Exe($name) {
  $cmd = Get-Command "$name.exe" -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\$name.exe",
    "$env:LOCALAPPDATA\ComboBreaker\native\$name.exe",
    "$env:ProgramFiles\nodejs\$name.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\$name.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

function Install-WithWinget($name, $packageId) {
  $found = Find-Exe $name
  if ($found) { Write-Host "$name already installed: $found"; return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "$name is missing and winget is not available. Install $name manually, then re-run this command."
    return
  }
  Write-Host "Installing $name ($packageId)..."
  winget install --id $packageId --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  $found = Find-Exe $name
  if ($found) { Write-Host "$name installed: $found" }
  else { Write-Warning "$name did not show up after install. Open a new terminal and re-run this command." }
}

Step '1/3  Tools (yt-dlp, ffmpeg, Node.js)'
Install-WithWinget 'yt-dlp' 'yt-dlp.yt-dlp'
Install-WithWinget 'ffmpeg' 'Gyan.FFmpeg'
Install-WithWinget 'node'   'OpenJS.NodeJS.LTS'

$node = Find-Exe 'node'
if (-not $node) { throw 'Node.js is required for the helper and could not be installed. Install it from https://nodejs.org and re-run this command.' }

Step '2/3  Helper'
$installDir = Join-Path $env:LOCALAPPDATA 'ComboBreaker\native'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$hostJs = Join-Path $installDir 'host.js'
$localHost = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'host.js' } else { $null }
if ($localHost -and (Test-Path $localHost)) {
  Copy-Item $localHost $hostJs -Force
  Write-Host "Copied host.js from $PSScriptRoot"
} else {
  Invoke-WebRequest -UseBasicParsing -Uri "$Source/host.js" -OutFile $hostJs
  Write-Host "Downloaded host.js from $Source"
}

# Chrome needs a real executable; a .bat that execs node works.
$batPath = Join-Path $installDir 'combobreaker_host.bat'
[System.IO.File]::WriteAllText($batPath, "@echo off`r`n`"$node`" `"$hostJs`" %*`r`n", [System.Text.Encoding]::ASCII)

Step '3/3  Browser registration'
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
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

$regRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Vivaldi\NativeMessagingHosts'
)
foreach ($root in $regRoots) {
  $key = Join-Path $root $HostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
}
Write-Host "Registered $HostName for extension $ExtensionId"

Write-Host ''
Write-Host 'All set. Go back to the ComboBreaker Setup page and click "Check again".' -ForegroundColor Green
