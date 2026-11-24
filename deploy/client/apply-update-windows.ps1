# The privileged half of an operator-triggered REACH Client update on Windows. Run by the one-shot Scheduled Task 'REACH Client Update'
# (SYSTEM) after the Client staged a verified archive and asked for it. It holds no install logic of its own: it reruns the public installer
# (install.ps1: manifest selection, size and SHA-256 check, the swap, the Scheduled Task and its restart) on the staged archive. The installer is
# copied out of the install first, because the install directory is moved aside while it runs.
# It is also the ONLY author of the terminal result (update\apply-result.json): the Client's apply-request.json is copied verbatim and closed with the
# outcome, byte for byte what apply-update-linux.sh writes. The request is correlation only, never an authority over the installer.
param(
  [Parameter(Mandatory = $true)][string]$Bootstrap,
  [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$StateDir = Split-Path -Parent $Bootstrap
$Staged = Join-Path $StateDir 'update\client.zip'
$RequestFile = Join-Path $StateDir 'update\apply-request.json'
$ResultFile = Join-Path $StateDir 'update\apply-result.json'
# Without a valid request there is nothing to correlate a result to, and a result is never invented: stop here.
if (-not (Test-Path -LiteralPath $RequestFile -PathType Leaf)) { throw 'no apply request' }
$Request = (Get-Content -LiteralPath $RequestFile -Raw).Trim()
if ($Request -cnotmatch '^\{"schema_version":1,"update_id":"[^"\\]+","from_build":"[^"\\]+","target_build":"[^"\\]+","artifact_sha256":"[0-9a-f]{64}"\}$' -or $Request -match '\p{Cc}') { throw 'the apply request is not the canonical shape' }

# Commits the terminal result atomically (temp file, flush to disk, replace) and only then drops the request; a write that fails throws and leaves no half result.
function Write-Result([string]$State, [string]$Tail) {
  $Temp = "$ResultFile.tmp"
  $Bytes = (New-Object Text.UTF8Encoding $false).GetBytes($Request.Substring(0, $Request.Length - 1) + ",`"state`":`"$State`"$Tail}`n")
  $Stream = [IO.File]::Open($Temp, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try { $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) } finally { $Stream.Dispose() }
  if (Test-Path -LiteralPath $ResultFile) { [IO.File]::Replace($Temp, $ResultFile, $null) } else { [IO.File]::Move($Temp, $ResultFile) }
  Remove-Item -LiteralPath $RequestFile -Force
}

# The Client is (re)started only after its result is committed, so the new process always finds its receipt: a restart also makes a Client that was never stopped report it.
function Restart-Client {
  Stop-ScheduledTask -TaskName 'REACH Client' -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName 'REACH Client' -ErrorAction Stop
}

$Work = Join-Path ([IO.Path]::GetTempPath()) ("reach-update-" + [Guid]::NewGuid().ToString('N'))
$Failure = $null
try {
  if (-not (Test-Path -LiteralPath $Staged -PathType Leaf)) { throw 'no staged archive' }
  $Url = (Get-Content -LiteralPath $Bootstrap | Where-Object { $_ -like 'REACH_SERVER_URL=*' } | Select-Object -First 1)
  if ($Url -notmatch '^REACH_SERVER_URL=ws://(?<authority>[^/]+)/client$') { throw 'the bootstrap endpoint is not a ws://host:port/client URL' }
  New-Item -ItemType Directory -Path $Work | Out-Null
  $Installer = Join-Path $Work 'install.ps1'
  Copy-Item -LiteralPath (Join-Path $InstallDir 'deploy\install.ps1') -Destination $Installer
  $env:REACH_SERVER_ORIGIN = "http://$($Matches['authority'])"
  $env:REACH_STATE_DIR = $StateDir
  $env:REACH_INSTALL_DIR = $InstallDir
  $env:REACH_STAGED = $Staged
  $env:REACH_NO_START = '1'
  $Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $Shell -NoProfile -ExecutionPolicy Bypass -File $Installer
  if ($LASTEXITCODE -ne 0) { throw 'the installer failed; the current install was left in place' }
} catch {
  $Failure = $_
} finally {
  Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($null -ne $Failure) {
  Write-Result 'failed' ',"reason":"apply"'
  try { Restart-Client } catch { }
  throw $Failure
}
Write-Result 'applied' ''
# `applied` means the verified swap is committed and the start was requested; if the start itself is refused the attempt is `failed`, still before any new Client could connect.
try { Restart-Client } catch { Write-Result 'failed' ',"reason":"apply"'; throw }
