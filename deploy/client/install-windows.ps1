# Machine-level REACH Client install for Windows, from the release artifact (reach-client-win32-x64.zip): one Client per machine,
# never per project. The install directory and the bootstrap file are separate: binaries go to the install directory, while the
# endpoint, Client id, private key and root anchors stay only in the operator's protected bootstrap file, which this script never
# reads or copies. Startup is one plain Scheduled Task running Node on the installed launcher; REACH has no supervisor of its own.
# Install and update are explicit operator actions; nothing here updates itself.
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Bootstrap,
  [Parameter(Mandatory = $true)][string]$Build,
  [string]$InstallDir = 'C:\Program Files\REACH\Client',
  [string]$NodePath = '',
  [string]$TaskName = 'REACH Client',
  [switch]$AllowInsecureWs,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
$Top = 'reach-client'

function Assert-AbsolutePath([string]$Name, [string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:\\') { throw "$Name must be an absolute path with a drive letter" }
  if ($Value -match '["<>|*?\x00-\x1f]') { throw "$Name contains a character that is not allowed" }
  $segments = $Value.Substring(3).TrimEnd('\').Split('\')
  if ($segments.Count -lt 2) { throw "$Name must be at least two segments deep" }
  if ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) { throw "$Name must not contain empty, . or .. segments" }
}

Assert-AbsolutePath 'InstallDir' $InstallDir
Assert-AbsolutePath 'Bootstrap' $Bootstrap
$InstallDir = $InstallDir.TrimEnd('\')
if ($Bootstrap.StartsWith($InstallDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Bootstrap must live outside the install directory (the bootstrap is not part of the install)' }
if ($Build -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'Build must be 1 to 128 characters: letters, digits and . _ -' }
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'Archive is not a file' }
if ($NodePath -eq '') { $NodePath = (Get-Command node).Source }
Assert-AbsolutePath 'NodePath' $NodePath

$Launcher = Join-Path $InstallDir "$Top.mjs"
if ((Test-Path -LiteralPath $InstallDir) -and (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1) -and -not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
  throw "$InstallDir exists, is not empty and is not a REACH Client install: refusing to replace it"
}

$Stage = "$InstallDir.new"
$Old = "$InstallDir.old"
foreach ($leftover in @($Stage, $Old)) { if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Recurse -Force } }
New-Item -ItemType Directory -Path (Split-Path -Parent $InstallDir) -Force | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $Stage
if (-not (Test-Path -LiteralPath (Join-Path $Stage "$Top\$Top.mjs") -PathType Leaf)) { Remove-Item -LiteralPath $Stage -Recurse -Force; throw "archive has no $Top\$Top.mjs launcher" }
if (Get-ChildItem -LiteralPath $Stage -Recurse -Force | Where-Object { $_.LinkType }) { Remove-Item -LiteralPath $Stage -Recurse -Force; throw 'archive contains a link: refusing the archive' }

# Replace: a failure before the swap leaves the previous install untouched; the old tree is removed only after the new one is in place.
if (Test-Path -LiteralPath $InstallDir) { Move-Item -LiteralPath $InstallDir -Destination $Old }
try { Move-Item -LiteralPath (Join-Path $Stage $Top) -Destination $InstallDir }
catch {
  if (Test-Path -LiteralPath $Old) { Move-Item -LiteralPath $Old -Destination $InstallDir }
  throw 'could not move the new install into place; the previous install was restored'
}
Remove-Item -LiteralPath $Stage -Recurse -Force
if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Recurse -Force }

# The task arguments carry only the launcher, the bootstrap path and the build id; paths are quoted because Program Files has a space.
$Arguments = "`"$Launcher`" --bootstrap `"$Bootstrap`" --build $Build"
if ($AllowInsecureWs) { $Arguments += ' --allow-insecure-ws' }
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument $Arguments -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $TaskName }
Write-Output "installed $InstallDir, scheduled task '$TaskName'"
