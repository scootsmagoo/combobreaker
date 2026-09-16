<#
.SYNOPSIS
  Removes the ComboBreaker yt-dlp native messaging host registration and files.
#>
[CmdletBinding()]
param(
  [string]$HostName = 'com.combobreaker.ytdlp'
)

$ErrorActionPreference = 'SilentlyContinue'

$roots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Vivaldi\NativeMessagingHosts'
)
foreach ($r in $roots) {
  $key = Join-Path $r $HostName
  if (Test-Path $key) {
    Remove-Item -Path $key -Recurse -Force
    Write-Host "Removed $key"
  }
}

$installDir = Join-Path $env:LOCALAPPDATA 'ComboBreaker\native'
if (Test-Path $installDir) {
  Remove-Item -Path $installDir -Recurse -Force
  Write-Host "Removed $installDir"
}
Write-Host 'Done.'
