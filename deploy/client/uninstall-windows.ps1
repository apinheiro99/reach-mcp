# Machine-level REACH Client uninstall for Windows, shipped inside the verified Windows Client archive next to install-windows.ps1.
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<install-dir>\deploy\uninstall-windows.ps1" [-StateDir <abs-dir>]     (elevated)
# It trusts only the install receipt written by the installer (<StateDir>\install-receipt.json) and removes only what that receipt proves REACH
# owns: the REACH Scheduled Task, the Node processes started from the recorded install directory, the runtime, the bootstrap (and with it the
# Client's private key), the receipt, and the state directory and the root only when the installer created them and they are empty. A custom
# root, a directory that is not empty and a task that is not REACH's are left alone. Safe to run again. It never touches the Server: the Client
# record there stays until an administrator removes it.
param(
  [string]$StateDir = 'C:\ProgramData\REACH\Client'
)
$ErrorActionPreference = 'Stop'
# Progress rendering makes Expand-Archive and friends orders of magnitude slower and can block on a console; the installer never needs it.
$ProgressPreference = 'SilentlyContinue'
$DefaultInstallDir = 'C:\Program Files\REACH\Client'

function Fail([string]$Message) { throw "uninstall-windows: $Message" }

# Elevation is proved by the capability itself, not by token membership: opening the machine hive for writing succeeds only with
# administrative rights, changes nothing, and any failure stops here, before the first change.
try { [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE', $true).Dispose() } catch { Fail 'run this in an elevated (Administrator) PowerShell' }
$StateDir = $StateDir.TrimEnd('\')
$Receipt = Join-Path $StateDir 'install-receipt.json'

if (-not (Test-Path -LiteralPath $Receipt -PathType Leaf)) {
  # No receipt means no proof of what is REACH's: an install that still exists is refused, a clean machine is already done.
  if ((Test-Path -LiteralPath $DefaultInstallDir) -or ($null -ne (Get-ScheduledTask -TaskName 'REACH Client' -ErrorAction SilentlyContinue))) {
    Fail "no install receipt at $Receipt, but a REACH-looking install or task exists: refusing to guess what is REACH's"
  }
  Write-Output "Nothing to uninstall: no REACH Client receipt at $Receipt."
  return
}

try { $R = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json } catch { Fail 'the install receipt is not valid JSON' }
# Plain syntax only, the grammar the installer writes: the state and install directories sit below the drive root, the project root may be a whole drive.
function Test-PlainPath($Value, [bool]$AllowDriveRoot = $false) {
  $Pattern = if ($AllowDriveRoot) { '^[A-Za-z]:\\[A-Za-z0-9._ \\-]*$' } else { '^[A-Za-z]:\\[A-Za-z0-9._ \\-]+$' }
  return ($Value -is [string]) -and ($Value -match $Pattern) -and ($Value -notmatch '(^|\\)\.\.?(\\|$)|\\\\')
}
if ($R.schema_version -ne 1 -or $R.platform -ne 'win32') { Fail 'unsupported install receipt' }
foreach ($key in @('install_dir', 'state_dir', 'bootstrap', 'root')) { if (-not (Test-PlainPath $R.$key ($key -eq 'root'))) { Fail "the receipt has a bad $key" } }
if ($R.state_dir.TrimEnd('\') -ne $StateDir) { Fail 'the receipt belongs to another state directory' }
if ($R.bootstrap -ne (Join-Path $StateDir 'bootstrap.env')) { Fail 'the receipt bootstrap is not inside its state directory' }
if ($R.task_name -ne 'REACH Client') { Fail 'the receipt names a task that is not the REACH task' }
if ($null -eq $R.owned) { Fail 'the receipt has no ownership flags' }
$InstallDir = $R.install_dir.TrimEnd('\')
$Root = $R.root.TrimEnd('\')
if ($Root -match '^[A-Za-z]:$') { $Root = "$Root\" }
if ($Root -eq $InstallDir) { Fail 'the receipt root is the install directory' }
$Kept = @()

# The task: only one that runs the REACH launcher from the recorded install directory is stopped and removed.
$Task = Get-ScheduledTask -TaskName $R.task_name -ErrorAction SilentlyContinue
if ($null -ne $Task) {
  $TaskArgs = ($Task.Actions | ForEach-Object { "$($_.Arguments)" }) -join ' '
  if ($TaskArgs.IndexOf("`"$InstallDir\reach-client.mjs`"", [StringComparison]::OrdinalIgnoreCase) -lt 0) { Fail "scheduled task '$($R.task_name)' does not run the REACH Client from ${InstallDir}: refusing to remove it" }
  Stop-ScheduledTask -TaskName $R.task_name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $R.task_name -Confirm:$false
  Unregister-ScheduledTask -TaskName 'REACH Client Update' -Confirm:$false -ErrorAction SilentlyContinue
}

# Only Node processes started from the recorded install directory are stopped, then the runtime goes: only a directory that holds the REACH launcher.
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue
$Deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $Deadline -and (Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase) })) { Start-Sleep -Milliseconds 300 }
if (Test-Path -LiteralPath $InstallDir) {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'reach-client.mjs') -PathType Leaf)) { Fail "$InstallDir is not a REACH Client install: refusing to remove it" }
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

# The bootstrap carries the Client's id and private key: it goes with the install. A directory is removed only when REACH created it and it is empty.
Remove-Item -LiteralPath $R.bootstrap -Force -ErrorAction SilentlyContinue
function Remove-IfEmpty([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1) { $script:Kept += $Path } else { Remove-Item -LiteralPath $Path -Force }
}
# A drive root is never removed, whatever the receipt says.
if ([bool]$R.owned.root -and $Root.Length -gt 3) { Remove-IfEmpty $Root }
Remove-Item -LiteralPath $Receipt -Force
if ([bool]$R.owned.state_dir) { Remove-IfEmpty $StateDir }
foreach ($parent in @((Split-Path -Parent $InstallDir), (Split-Path -Parent $StateDir))) {
  if ((Split-Path -Leaf $parent) -eq 'REACH' -and (Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $parent -Force }
}
$Suffix = if ($Kept.Count -gt 0) { " Left in place (not empty): $($Kept -join ', ')" } else { '' }
Write-Output "REACH Client uninstalled.$Suffix"
Write-Output 'The Server still lists this Client until an administrator removes it there.'
