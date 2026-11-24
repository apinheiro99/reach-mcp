# The privileged half of an operator-triggered REACH Client update on Windows. Run by the one-shot Scheduled Task 'REACH Client Update'
# (SYSTEM) after the Client staged a verified archive and asked for it. It holds no install logic of its own: it reruns the public installer
# (install.ps1: manifest selection, size and SHA-256 check, the swap, the Scheduled Task and its restart) on the staged archive. The installer is
# copied out of the install first, because the install directory is moved aside while it runs.
param(
  [Parameter(Mandatory = $true)][string]$Bootstrap,
  [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$StateDir = Split-Path -Parent $Bootstrap
$Staged = Join-Path $StateDir 'update\client.zip'
if (-not (Test-Path -LiteralPath $Staged -PathType Leaf)) { throw 'no staged archive' }
$Url = (Get-Content -LiteralPath $Bootstrap | Where-Object { $_ -like 'REACH_SERVER_URL=*' } | Select-Object -First 1)
if ($Url -notmatch '^REACH_SERVER_URL=ws://(?<authority>[^/]+)/client$') { throw 'the bootstrap endpoint is not a ws://host:port/client URL' }
$Work = Join-Path ([IO.Path]::GetTempPath()) ("reach-update-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  $Installer = Join-Path $Work 'install.ps1'
  Copy-Item -LiteralPath (Join-Path $InstallDir 'deploy\install.ps1') -Destination $Installer
  $env:REACH_SERVER_ORIGIN = "http://$($Matches['authority'])"
  $env:REACH_STATE_DIR = $StateDir
  $env:REACH_INSTALL_DIR = $InstallDir
  $env:REACH_STAGED = $Staged
  $Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $Shell -NoProfile -ExecutionPolicy Bypass -File $Installer
  if ($LASTEXITCODE -ne 0) { throw 'the installer failed; the current install was left in place' }
} finally {
  Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
