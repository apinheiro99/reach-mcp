# The public one-line REACH Client installer for Windows, served by the Server as /install.ps1 and declared in the release manifest.
#   $env:REACH_SERVER_ORIGIN='http://<server>'; irm http://<server>/install.ps1 | iex     (elevated PowerShell 5.1 or later)
# A script piped to iex cannot know where it came from, so the origin is explicit and never guessed. It reads the release manifest
# (schema v2) from that origin, selects the one client/win32/x64 artifact, downloads it from the manifest's relative path, verifies size
# and SHA-256, and hands the archive to the low-level installer it carries (deploy\install-windows.ps1, the sole owner of the swap and
# the Scheduled Task). The archive carries its own pinned Node runtime, so the machine needs no Node. It writes a bootstrap with only the
# endpoint and a narrow root; the Client generates its own id and private key on first start, nothing here makes or sees them.
$ErrorActionPreference = 'Stop'
# Progress rendering makes Expand-Archive and friends orders of magnitude slower and can block on a console; the installer never needs it.
$ProgressPreference = 'SilentlyContinue'
$StateDir = if ($env:REACH_STATE_DIR) { $env:REACH_STATE_DIR } else { 'C:\ProgramData\REACH\Client' }
$InstallDir = if ($env:REACH_INSTALL_DIR) { $env:REACH_INSTALL_DIR } else { 'C:\Program Files\REACH\Client' }
$RootGiven = [bool]$env:REACH_ROOT
$AllowWholeDrive = $env:REACH_ALLOW_WHOLE_DRIVE -eq '1'
$Root = if ($env:REACH_ROOT) { $env:REACH_ROOT } else { Join-Path $StateDir 'root' }
$Origin = "$env:REACH_SERVER_ORIGIN".TrimEnd('/')
# An archive the Client already downloaded (an operator-triggered update); it is still checked against the manifest below before anything changes.
$Staged = $env:REACH_STAGED

function Fail([string]$Message) { throw "install.ps1: $Message" }

# A plain http:// authority: host name, IPv4 or bracketed IPv6, an optional port, nothing else.
if ($Origin -eq '') { Fail 'set $env:REACH_SERVER_ORIGIN to http://<host>[:<port>] first' }
if ($Origin -notmatch '^http://(?<authority>([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?)$') { Fail 'REACH_SERVER_ORIGIN must be a plain http://host[:port] with no credentials, path, query or fragment' }
$Authority = $Matches['authority']
# Plain syntax only: an absolute drive path of letters, digits, space and . _ -, no . or .. segments. How deep a path is is not a safety property;
# what protects the machine is ownership (a state or install directory that is not REACH's is refused below and by the machine installer).
# The state and install directories are what this installer owns, so they must be a directory below the drive root; the project root is the operator's choice.
foreach ($pair in @(@('REACH_STATE_DIR', $StateDir, $false), @('REACH_INSTALL_DIR', $InstallDir, $false), @('REACH_ROOT', $Root, $true))) {
  $Pattern = if ($pair[2]) { '^[A-Za-z]:\\[A-Za-z0-9._ \\-]*$' } else { '^[A-Za-z]:\\[A-Za-z0-9._ \\-]+$' }
  if ($pair[1] -notmatch $Pattern -or $pair[1] -match '(^|\\)\.\.?(\\|$)|\\\\') { Fail "$($pair[0]) must be an absolute drive path of letters, digits, space and . _ -" }
}
# A drive root is one comparable form everywhere: "C:\", never "C:" (which Windows reads as the current directory of that drive).
function Format-Root([string]$Path) { $t = $Path.TrimEnd('\'); if ($t -match '^[A-Za-z]:$') { return "$t\" } return $t }
$Root = Format-Root $Root
if ($Root.Length -le 3) {
  # Sharing a whole drive is the operator's decision, never a default: it is shown and confirmed on purpose.
  [Console]::Error.WriteLine("install.ps1: WARNING: REACH_ROOT $Root shares the WHOLE DRIVE of this machine with the REACH Server (as / would on Linux).")
  if (-not $AllowWholeDrive) { Fail 'to confirm it, set $env:REACH_ALLOW_WHOLE_DRIVE=''1'' and run again' }
}

$Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($Arch -ne 'AMD64') { Fail "unsupported architecture ${Arch}: only x64 is supported" }
$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'run this in an elevated (Administrator) PowerShell' }

# Ownership is decided before the first change: what this installer creates is recorded as owned, anything that already existed is never claimed.
# A rerun keeps the original flags and the root of the first install; a different REACH_ROOT has to wait for an uninstall.
$Receipt = Join-Path $StateDir 'install-receipt.json'
$Bootstrap = Join-Path $StateDir 'bootstrap.env'
if (Test-Path -LiteralPath $Receipt -PathType Leaf) {
  try { $Prior = Get-Content -LiteralPath $Receipt -Raw | ConvertFrom-Json } catch { Fail "the install receipt $Receipt is unreadable" }
  if ($Prior.schema_version -ne 1 -or $Prior.platform -ne 'win32' -or $Prior.root -isnot [string] -or $null -eq $Prior.owned) { Fail "the install receipt $Receipt is not a REACH receipt" }
  # The receipt is the identity of one installation: its runtime coordinates cannot be redefined by a rerun.
  if ($Prior.task_name -ne 'REACH Client' -or $Prior.state_dir -isnot [string] -or $Prior.state_dir.TrimEnd('\') -ne $StateDir.TrimEnd('\') -or $Prior.bootstrap -ne $Bootstrap) { Fail "the install receipt $Receipt does not match this machine's REACH state" }
  if ($Prior.install_dir -isnot [string] -or $Prior.install_dir.TrimEnd('\') -ne $InstallDir.TrimEnd('\')) { Fail "this machine is already installed in $($Prior.install_dir): uninstall first to change REACH_INSTALL_DIR" }
  if ($RootGiven -and $(Format-Root $Prior.root) -ne $Root) { Fail "this machine is already installed with root $($Prior.root): uninstall first to change it" }
  $Root = $Prior.root
  $OwnState = [bool]$Prior.owned.state_dir
  $OwnRoot = [bool]$Prior.owned.root
} else {
  $OwnState = -not (Test-Path -LiteralPath $StateDir)
  $OwnRoot = -not (Test-Path -LiteralPath $Root)
}

$Work = Join-Path ([IO.Path]::GetTempPath()) ("reach-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  # One fetch policy: plain http to the given origin only, and no redirect at all, so the origin can never be switched silently.
  function Get-Release([string]$RelativePath, [string]$OutFile) {
    $request = [Net.HttpWebRequest]::Create("$Origin$RelativePath")
    $request.AllowAutoRedirect = $false
    $request.Timeout = 600000
    $request.ReadWriteTimeout = 600000
    try { $response = $request.GetResponse() } catch { Fail "could not download $Origin${RelativePath}: $($_.Exception.Message)" }
    try {
      if ([int]$response.StatusCode -ne 200) { Fail "$Origin$RelativePath answered $([int]$response.StatusCode)" }
      $file = [IO.File]::Create($OutFile)
      try { $response.GetResponseStream().CopyTo($file) } finally { $file.Dispose() }
    } finally { $response.Close() }
  }

  $ManifestFile = Join-Path $Work 'manifest.json'
  Get-Release '/release/manifest' $ManifestFile
  # Trust on first use (ADR-0005): the Server public key becomes the Client's pin. It travels over the same plain http as the rest, so it is not authenticated by itself;
  # REACH_SERVER_TRUST_KEY (obtained out of band) turns it into an expected value that must match. No signature is verified here: PowerShell 5.1 has no trustworthy Ed25519.
  $TrustFile = Join-Path $Work 'trust-key.json'
  Get-Release '/release/trust-key' $TrustFile
  try { $ServerKey = (Get-Content -LiteralPath $TrustFile -Raw | ConvertFrom-Json).public_key } catch { Fail 'the Server did not publish a valid trust key' }
  if ($ServerKey -isnot [string] -or $ServerKey -cnotmatch '^[A-Za-z0-9_-]{43}$') { Fail 'the Server did not publish a valid trust key' }
  if ("$env:REACH_SERVER_TRUST_KEY" -ne '' -and "$env:REACH_SERVER_TRUST_KEY" -cne $ServerKey) { Fail 'the Server trust key differs from REACH_SERVER_TRUST_KEY: nothing was pinned or installed' }
  # An existing pin is trust state: a normal install, rerun or update never replaces it from this unauthenticated http answer. Replacing it is the separate, explicit
  # $env:REACH_RECOVER_TRUST='1', and only with the new key supplied out of band. Every check here runs before anything is created or changed.
  $Recover = "$env:REACH_RECOVER_TRUST" -eq '1'
  $ExistingPin = ''
  if (Test-Path -LiteralPath $Bootstrap -PathType Leaf) { $PinMatch = [Text.RegularExpressions.Regex]::Match([IO.File]::ReadAllText($Bootstrap), '(?m)^REACH_SERVER_TRUST_KEY=(\S+)\r?$'); if ($PinMatch.Success) { $ExistingPin = $PinMatch.Groups[1].Value } }
  if ($Recover) {
    if ($Staged) { Fail 'REACH_RECOVER_TRUST cannot be combined with an update: an update never changes the pinned Server key' }
    if ("$env:REACH_SERVER_TRUST_KEY" -eq '') { Fail 'REACH_RECOVER_TRUST needs REACH_SERVER_TRUST_KEY set to the new Server public key, obtained out of band: nothing was changed' }
  } elseif ($ExistingPin -ne '' -and $ExistingPin -cne $ServerKey) {
    Fail 'the Server publishes a key that differs from the one pinned in the bootstrap: nothing was changed. If the Server key was really replaced, set $env:REACH_RECOVER_TRUST=''1'' and REACH_SERVER_TRUST_KEY to the new key obtained out of band, then rerun'
  }
  try { $Manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json } catch { Fail 'the release manifest is not valid JSON' }
  if ($Manifest.schema_version -ne 2) { Fail "unsupported release manifest schema_version $($Manifest.schema_version) (need 2)" }
  $Hits = @($Manifest.artifacts | Where-Object { $_.role -eq 'client' -and $_.os -eq 'win32' -and $_.arch -eq 'x64' })
  if ($Hits.Count -ne 1) { Fail "the manifest must list exactly one client artifact for win32/x64, found $($Hits.Count)" }
  $Artifact = $Hits[0]
  $Build = $Manifest.client.build_id
  if ($Artifact.download_path -isnot [string] -or $Artifact.download_path -notmatch '^/release/artifacts/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { Fail 'the manifest download_path is not a relative /release/artifacts/<name> path' }
  if ($Artifact.sha256 -isnot [string] -or $Artifact.sha256 -cnotmatch '^[0-9a-f]{64}$') { Fail 'the manifest sha256 is not 64 lowercase hex' }
  if ($Artifact.size_bytes -isnot [int] -and $Artifact.size_bytes -isnot [long]) { Fail 'the manifest size_bytes is not a positive integer' }
  if ($Artifact.size_bytes -le 0) { Fail 'the manifest size_bytes is not a positive integer' }
  if ($Build -isnot [string] -or $Build -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { Fail 'the manifest client build id is not a plain identifier' }

  $ArchiveFile = Join-Path $Work 'client.zip'
  if ($Staged) { Copy-Item -LiteralPath $Staged -Destination $ArchiveFile } else { Get-Release $Artifact.download_path $ArchiveFile }
  if ((Get-Item -LiteralPath $ArchiveFile).Length -ne $Artifact.size_bytes) { Fail "the downloaded size differs from the manifest $($Artifact.size_bytes)" }
  if ((Get-FileHash -LiteralPath $ArchiveFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Artifact.sha256) { Fail 'the downloaded SHA-256 differs from the manifest' }

  # The verified archive carries the low-level installer: the one owner of the atomic swap and the Scheduled Task.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [IO.Compression.ZipFile]::OpenRead($ArchiveFile)
  try {
    $Entry = $Zip.GetEntry('reach-client/deploy/install-windows.ps1')
    if ($null -eq $Entry) { Fail 'the archive has no reach-client/deploy/install-windows.ps1' }
    $LowLevel = Join-Path $Work 'install-windows.ps1'
    [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $LowLevel)
    if ($null -eq $Zip.GetEntry('reach-client/runtime/node.exe')) { Fail 'the archive carries no Node runtime (reach-client/runtime/node.exe)' }
  } finally { $Zip.Dispose() }

  # A task of that name that does not run the REACH launcher is someone else's: refuse before the first change (the low-level installer checks again).
  $Occupant = Get-ScheduledTask -TaskName 'REACH Client' -ErrorAction SilentlyContinue
  if ($null -ne $Occupant -and (($Occupant.Actions | ForEach-Object { "$($_.Arguments)" }) -join ' ').IndexOf("`"$($InstallDir.TrimEnd('\'))\reach-client.mjs`"", [StringComparison]::OrdinalIgnoreCase) -lt 0) { Fail "scheduled task 'REACH Client' exists and is not a REACH Client task: refusing to replace it" }

  # Machine changes start here, after everything above was validated.
  $Endpoint = "ws://$Authority/client"
  # An older install without a receipt keeps its bootstrap and its root untouched: no new path is created for it.
  # A drive root (C:\ after confirmation) exists already and cannot be created: only the state directory is.
  $Create = @($StateDir)
  if ((-not (Test-Path -LiteralPath $Bootstrap -PathType Leaf) -or (Test-Path -LiteralPath $Receipt -PathType Leaf)) -and $Root -ne [IO.Path]::GetPathRoot($Root)) { $Create += $Root }
  New-Item -ItemType Directory -Path $Create -Force | Out-Null
  & icacls.exe $StateDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'could not restrict the ACL of the state directory' }
  $Utf8 = New-Object Text.UTF8Encoding($false)
  if (Test-Path -LiteralPath $Bootstrap -PathType Leaf) {
    # A rerun keeps the identity and the root; only the endpoint follows the origin given now.
    $Text = [IO.File]::ReadAllText($Bootstrap)
    $Updated = [Text.RegularExpressions.Regex]::Replace($Text, '(?m)^REACH_SERVER_URL=.*$', "REACH_SERVER_URL=$Endpoint")
    # A bootstrap without a pin (installed before pinning) gets it once; with recovery a different pin is replaced and its epoch, digest and generation are reset together.
    # Otherwise an existing pin was proved equal above and nothing about it changes.
    if ($ExistingPin -eq '' -or ($Recover -and $ExistingPin -cne $ServerKey)) {
      $Updated = [Text.RegularExpressions.Regex]::Replace($Updated, '(?m)^(REACH_SERVER_TRUST_KEY|REACH_RELEASE_EPOCH|REACH_RELEASE_DIGEST|REACH_ROTATION_GENERATION)=.*\r?\n?', '')
      if ($Updated.Length -gt 0 -and -not $Updated.EndsWith("`n")) { $Updated += "`n" }
      $Updated += "REACH_SERVER_TRUST_KEY=$ServerKey`n"
    }
    if ($Updated -ne $Text) { [IO.File]::WriteAllText($Bootstrap, $Updated, $Utf8) }
  } else {
    $RootJson = $Root.Replace('\', '\\')
    [IO.File]::WriteAllText($Bootstrap, "REACH_SERVER_URL=$Endpoint`nREACH_ROOTS=[`"$RootJson`"]`nREACH_SERVER_TRUST_KEY=$ServerKey`n", $Utf8)
  }

  # A child process with a Bypass policy: a default Windows client refuses to run a .ps1 file, even though iex of this text is allowed.
  $Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $Shell -NoProfile -ExecutionPolicy Bypass -File $LowLevel -Archive $ArchiveFile -Bootstrap $Bootstrap -Build $Build -InstallDir $InstallDir -AllowInsecureWs -Start
  if ($LASTEXITCODE -ne 0) { Fail 'the machine installer failed; see its message above' }
  # The receipt is written only after a successful install and holds no identity or secret: it is what the uninstaller trusts.
  $ReceiptBody = [ordered]@{ schema_version = 1; platform = 'win32'; install_dir = $InstallDir; state_dir = $StateDir; bootstrap = $Bootstrap; root = $Root; task_name = 'REACH Client'; owned = [ordered]@{ state_dir = $OwnState; root = $OwnRoot } }
  [IO.File]::WriteAllText("$Receipt.tmp", ($ReceiptBody | ConvertTo-Json -Depth 4), $Utf8)
  Move-Item -LiteralPath "$Receipt.tmp" -Destination $Receipt -Force
  Write-Output "To remove it later (elevated): powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\deploy\uninstall-windows.ps1`" -StateDir `"$StateDir`""
  Write-Output "REACH Client installed. It registers with $Origin as Pending; an administrator must Enable it in the Admin UI."
} finally {
  Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
