@echo off
setlocal
:: ComboBreaker Helper installer (Windows). Double-click to run.
::
:: The extension's setup page hands this file out with the extension id filled
:: in; pass an id on the command line to override it. Everything is installed
:: under %LOCALAPPDATA%\ComboBreaker\helper and registered for Chrome, Edge,
:: Brave, Chromium and Vivaldi (HKCU only, no admin rights needed).
:: Remove with %LOCALAPPDATA%\ComboBreaker\Uninstall ComboBreaker Helper.cmd
set "CB_EXT_ID=%~1"
if "%CB_EXT_ID%"=="" set "CB_EXT_ID=__CB_EXT_ID__"
set "CB_SOURCE=__CB_SOURCE__"
set "CB_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:CB_SELF); $m='#PS'+'BEGIN'; $i=$s.IndexOf($m); $p=Join-Path $env:TEMP 'combobreaker-helper-install.ps1'; [IO.File]::WriteAllText($p, $s.Substring($i+$m.Length)); & $p; exit $LASTEXITCODE"
echo.
if errorlevel 1 (
  echo Setup did not finish. Scroll up for the reason, then run this file again.
) else (
  echo All set. You can close this window and go back to your browser.
)
pause
exit /b
#PSBEGIN
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$HostName = 'com.combobreaker.ytdlp'
$Source = $env:CB_SOURCE
$ExtIds = @($env:CB_EXT_ID) | Where-Object { $_ -match '^[a-p]{32}$' }
if (-not $ExtIds) { throw "Extension id missing or invalid ('$($env:CB_EXT_ID)'). Download this installer again from ComboBreaker's setup page." }

$Helper = Join-Path $env:LOCALAPPDATA 'ComboBreaker\helper'
$Bin = Join-Path $Helper 'bin'
$PyDir = Join-Path $Helper 'python'
$Tmp = Join-Path $env:TEMP ('combobreaker-helper-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Bin, $Tmp | Out-Null

$Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$NodePlat = if ($Arch -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$PbsTriple = 'x86_64-pc-windows-msvc'   # no ARM build published; x64 runs under emulation
$FfAsset = 'ffmpeg-win32-x64'

function Step($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    + $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    ! $t" -ForegroundColor Yellow }
function Fetch($url, $dest) {
  Write-Host "    downloading $(Split-Path -Leaf $url)"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}
function Sha256($f) { (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower() }
function Runs($exe, $argv) {
  try { $null = & $exe @argv 2>&1; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
function Utf8NoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

Write-Host 'ComboBreaker Helper installer'
Write-Host "    Folder: $Helper"

Step 'Host script'
Fetch "$Source/host.js" (Join-Path $Helper 'host.js')
Ok 'downloaded host.js'

Step 'Node runtime'
$Node = Join-Path $Bin 'node.exe'
if (Runs $Node @('--version')) {
  Ok "already installed ($(& $Node --version))"
} else {
  $sums = (Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -UseBasicParsing).Content
  $line = $sums -split "`n" | Where-Object { $_ -match "node-v[0-9.]+-$NodePlat\.zip\s*$" } | Select-Object -First 1
  if (-not $line) { throw "no Node build for $NodePlat" }
  $parts = $line.Trim() -split '\s+'
  $want = $parts[0]; $fname = $parts[-1]
  $zip = Join-Path $Tmp $fname
  Fetch "https://nodejs.org/dist/latest-v22.x/$fname" $zip
  if ((Sha256 $zip) -ne $want.ToLower()) { throw 'Node download failed its checksum; try again' }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $Tmp 'node') -Force
  $nodeExe = Get-ChildItem -Path (Join-Path $Tmp 'node') -Recurse -Filter 'node.exe' | Select-Object -First 1
  Copy-Item $nodeExe.FullName $Node -Force
  Ok "installed $(& $Node --version)"
}

Step 'Python runtime (for yt-dlp)'
$Py = Join-Path $PyDir 'python.exe'
if (Runs $Py @('--version')) {
  Ok "already installed ($(& $Py --version))"
} else {
  $asset = $null
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest' -UseBasicParsing
    $asset = ($rel.assets | Where-Object { $_.name -match "^cpython-3\.13\.[0-9]+\+[0-9]+-$PbsTriple-install_only\.tar\.gz$" } | Select-Object -First 1).browser_download_url
  } catch {}
  if (-not $asset) { $asset = "https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.13.15%2B20260901-$PbsTriple-install_only.tar.gz" }
  $tgz = Join-Path $Tmp 'python.tar.gz'
  Fetch $asset $tgz
  $want = $null
  try { $want = ((Invoke-WebRequest -Uri "$asset.sha256" -UseBasicParsing).Content.Trim() -split '\s+')[0] } catch {}
  if (-not $want) { throw 'could not fetch the Python checksum; try again' }
  if ((Sha256 $tgz) -ne $want.ToLower()) { throw 'Python download failed its checksum; try again' }
  $pyTmp = Join-Path $Tmp 'py'
  New-Item -ItemType Directory -Force -Path $pyTmp | Out-Null
  & tar.exe -xzf $tgz -C $pyTmp
  if ($LASTEXITCODE -ne 0) { throw 'could not extract Python (tar.exe missing? Windows 10 1803 or newer ships it)' }
  if (Test-Path $PyDir) { Remove-Item -Recurse -Force $PyDir }
  Move-Item (Join-Path $pyTmp 'python') $PyDir
  Ok "installed $(& $Py --version)"
}

Step 'yt-dlp'
$Pyz = Join-Path $Helper 'yt-dlp.pyz'
if ((Test-Path $Pyz) -and (Runs $Py @($Pyz, '--version'))) {
  if (Runs $Py @($Pyz, '-U')) { Ok "up to date ($(& $Py $Pyz --version))" } else { Warn "self-update failed; keeping $(& $Py $Pyz --version)" }
} else {
  $tmpPyz = Join-Path $Tmp 'yt-dlp'
  Fetch 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp' $tmpPyz
  $sums = (Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS' -UseBasicParsing).Content
  $line = $sums -split "`n" | Where-Object { ($_.Trim() -split '\s+')[-1] -eq 'yt-dlp' } | Select-Object -First 1
  if (-not $line) { throw 'yt-dlp checksum list has no entry for the zip build' }
  $want = ($line.Trim() -split '\s+')[0]
  if ((Sha256 $tmpPyz) -ne $want.ToLower()) { throw 'yt-dlp download failed its checksum; try again' }
  Move-Item $tmpPyz $Pyz -Force
  Ok "installed $(& $Py $Pyz --version)"
}
Set-Content -Path (Join-Path $Bin 'yt-dlp.cmd') -Value '@"%~dp0..\python\python.exe" "%~dp0..\yt-dlp.pyz" %*' -Encoding ASCII

Step 'ffmpeg'
$Ffmpeg = Join-Path $Bin 'ffmpeg.exe'
if (Runs $Ffmpeg @('-version')) {
  Ok 'already installed'
} else {
  Fetch "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/$FfAsset" $Ffmpeg
  if (-not (Runs $Ffmpeg @('-version'))) { throw 'downloaded ffmpeg does not run on this machine' }
  Ok 'installed'
}

Step 'Registering with the browser'
$Wrapper = Join-Path $Helper 'run-host.cmd'
$wrapperText = "@echo off`r`nset `"PATH=%~dp0bin;%PATH%`"`r`nset `"CB_HELPER_DIR=%~dp0.`"`r`n`"%~dp0bin\node.exe`" `"%~dp0host.js`" %*`r`n"
Set-Content -Path $Wrapper -Value $wrapperText -Encoding ASCII -NoNewline

$ManifestPath = Join-Path $Helper "$HostName.json"
$origins = @()
foreach ($id in $ExtIds) { $origins += "chrome-extension://$id/" }
if (Test-Path $ManifestPath) {
  try {
    $old = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    foreach ($o in @($old.allowed_origins)) { if ($o -and ($origins -notcontains $o)) { $origins += $o } }
  } catch {}
}
$manifest = [ordered]@{
  name = $HostName
  description = 'ComboBreaker Helper (runs yt-dlp locally)'
  path = $Wrapper
  type = 'stdio'
  allowed_origins = @($origins)
}
Utf8NoBom $ManifestPath (ConvertTo-Json -InputObject $manifest -Depth 3)

$regRoots = @(
  'HKCU:\Software\Google\Chrome',
  'HKCU:\Software\Chromium',
  'HKCU:\Software\Microsoft\Edge',
  'HKCU:\Software\BraveSoftware\Brave-Browser',
  'HKCU:\Software\Vivaldi'
)
foreach ($root in $regRoots) {
  $key = "$root\NativeMessagingHosts\$HostName"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
  Ok ($root -replace '^HKCU:\\Software\\', '')
}

$uninst = Join-Path (Split-Path -Parent $Helper) 'Uninstall ComboBreaker Helper.cmd'
$u = "@echo off`r`n"
foreach ($root in $regRoots) {
  $u += "reg delete `"$($root -replace '^HKCU:\\', 'HKCU\')\NativeMessagingHosts\$HostName`" /f >nul 2>&1`r`n"
}
$u += "rmdir /s /q `"$Helper`"`r`necho ComboBreaker Helper removed.`r`npause`r`n"
Set-Content -Path $uninst -Value $u -Encoding ASCII -NoNewline

Step 'Checking the helper answers'
$test = @'
const { spawn } = require("child_process");
const p = spawn('"' + process.argv[2] + '"', [], { shell: true, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
let buf = Buffer.alloc(0);
p.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4) return;
  const n = buf.readUInt32LE(0);
  if (buf.length < 4 + n) return;
  const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
  try { p.kill(); } catch {}
  if (m.type === "pong" && m.ytdlp && m.ytdlp.path) {
    console.log("    yt-dlp " + m.ytdlp.version + (m.ffmpeg ? " - ffmpeg " + m.ffmpeg.version : " - ffmpeg missing"));
    process.exit(0);
  }
  console.error("    unexpected reply: " + JSON.stringify(m));
  process.exit(1);
});
const j = Buffer.from(JSON.stringify({ type: "ping", force: true }));
const h = Buffer.alloc(4); h.writeUInt32LE(j.length, 0);
p.stdin.write(Buffer.concat([h, j]));
setTimeout(() => { console.error("    timeout"); process.exit(1); }, 90000);
'@
$testFile = Join-Path $Tmp 'ping.js'
Utf8NoBom $testFile $test
& $Node $testFile $Wrapper
if ($LASTEXITCODE -ne 0) { throw 'the helper did not answer a ping. Run this installer again; if it keeps failing, open an issue with the output above.' }
Ok 'helper responds'

try { Remove-Item -Recurse -Force $Tmp } catch {}
Write-Host ''
Write-Host 'Done. Go back to your browser - ComboBreaker will show the helper as Connected.' -ForegroundColor White
Write-Host '    (If it still says not connected after a few seconds, fully quit and reopen the browser.)'
Write-Host "    Remove later with: $uninst"
