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
$DefaultInstallDir = 'C:\Program Files\REACH\Client'

function Fail([string]$Message) { throw "uninstall-windows: $Message" }

$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this in an elevated (Administrator) PowerShell' }
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
function Test-PlainPath($Value) {
  if ($Value -isnot [string] -or $Value -notmatch '^[A-Za-z]:\\[A-Za-z0-9._ \\-]+$' -or $Value -match '(^|\\)\.\.?(\\|$)|\\\\') { return $false }
  return $Value.Substring(3).TrimEnd('\').Split('\').Count -ge 2
}
if ($R.schema_version -ne 1 -or $R.platform -ne 'win32') { Fail 'unsupported install receipt' }
foreach ($key in @('install_dir', 'state_dir', 'bootstrap', 'root')) { if (-not (Test-PlainPath $R.$key)) { Fail "the receipt has a bad $key" } }
if ($R.state_dir.TrimEnd('\') -ne $StateDir) { Fail 'the receipt belongs to another state directory' }
if ($R.bootstrap -ne (Join-Path $StateDir 'bootstrap.env')) { Fail 'the receipt bootstrap is not inside its state directory' }
if ($R.task_name -ne 'REACH Client') { Fail 'the receipt names a task that is not the REACH task' }
if ($null -eq $R.owned) { Fail 'the receipt has no ownership flags' }
$InstallDir = $R.install_dir.TrimEnd('\')
$Root = $R.root.TrimEnd('\')
if ($Root -eq $InstallDir) { Fail 'the receipt root is the install directory' }
$Kept = @()

# The task: only one that runs the REACH launcher from the recorded install directory is stopped and removed.
$Task = Get-ScheduledTask -TaskName $R.task_name -ErrorAction SilentlyContinue
if ($null -ne $Task) {
  $TaskArgs = ($Task.Actions | ForEach-Object { "$($_.Arguments)" }) -join ' '
  if ($TaskArgs.IndexOf("`"$InstallDir\reach-client.mjs`"", [StringComparison]::OrdinalIgnoreCase) -lt 0) { Fail "scheduled task '$($R.task_name)' does not run the REACH Client from ${InstallDir}: refusing to remove it" }
  Stop-ScheduledTask -TaskName $R.task_name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $R.task_name -Confirm:$false
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
if ([bool]$R.owned.root) { Remove-IfEmpty $Root }
Remove-Item -LiteralPath $Receipt -Force
if ([bool]$R.owned.state_dir) { Remove-IfEmpty $StateDir }
foreach ($parent in @((Split-Path -Parent $InstallDir), (Split-Path -Parent $StateDir))) {
  if ((Split-Path -Leaf $parent) -eq 'REACH' -and (Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $parent -Force }
}
$Suffix = if ($Kept.Count -gt 0) { " Left in place (not empty): $($Kept -join ', ')" } else { '' }
Write-Output "REACH Client uninstalled.$Suffix"
Write-Output 'The Server still lists this Client until an administrator removes it there.'
