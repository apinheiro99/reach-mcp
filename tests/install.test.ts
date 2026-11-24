// Machine-level Client install contract. Linux is executed for real against a temporary prefix with a stand-in archive (the real
// release archive is installed in `npm run check:release`). Windows is proved structurally only: no PowerShell or Task Scheduler
// runs here, so native execution on a Windows host remains an explicit evidence limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const SCRIPT = path.join(import.meta.dirname, "..", "deploy", "client", "install-linux.sh");
const PS1 = path.join(import.meta.dirname, "..", "deploy", "client", "install-windows.ps1");
const LEAK_MARKER = "client-credential-" + "Xk93Pq41";
const base = mkdtempSync(path.join(tmpdir(), "reach-install-"));

/** A stand-in for reach-client-linux-x64.tgz: the same top directory and launcher name, a launcher that proves it ran. */
function archive(name = "client.tgz", extra?: (top: string) => void): string {
  const src = mkdtempSync(path.join(base, "src-"));
  const top = path.join(src, "reach-client");
  mkdirSync(path.join(top, "lib"), { recursive: true });
  writeFileSync(path.join(top, "reach-client.mjs"), "process.stdout.write('launcher ' + process.argv.slice(2).join(' ') + '\\n');\n");
  writeFileSync(path.join(top, "lib", "marker.txt"), "v1");
  extra?.(top);
  const file = path.join(base, name);
  execFileSync("tar", ["-czf", file, "-C", src, "reach-client"]);
  return file;
}

const dirs = () => {
  const root = mkdtempSync(path.join(base, "t-"));
  return { root, install: path.join(root, "opt", "reach client"), units: path.join(root, "units"), bootstrap: path.join(root, "private", "bootstrap.env") };
};
const run = (args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
const common = (d: { bootstrap: string; install: string; units: string }, file: string) => ["--archive", file, "--bootstrap", d.bootstrap, "--build", "dev-1", "--install-dir", d.install, "--unit-dir", d.units, "--node", process.execPath];

test("Linux: installs the extracted runtime to an explicit directory (spaces allowed) and writes a unit that runs the installed launcher, never the source tree", () => {
  const d = dirs();
  const result = run([...common(d, archive()), "--user", "dev", "--allow-insecure-ws"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(d.install, "lib", "marker.txt"), "utf8"), "v1");
  const unit = readFileSync(path.join(d.units, "reach-mcp-client.service"), "utf8");
  const exec = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert.equal(exec, `ExecStart="${process.execPath}" "${d.install}/reach-client.mjs" --bootstrap "${d.bootstrap}" --build dev-1 --allow-insecure-ws`);
  assert.match(unit, /^User=dev$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartPreventExitStatus=3$/m, "a Client the Server refused (exit 3) is not restarted in a loop");
  assert.doesNotMatch(unit, /packages\/|WorkingDirectory|reach-private|Environment|credential=/i, "no source checkout, no private path, no secret");
  assert.ok(!readdirSync(path.dirname(d.install)).some((n) => n.includes(".new.") || n.includes(".old.")), "no staging leftovers");
  const start = spawnSync(process.execPath, [path.join(d.install, "reach-client.mjs"), "--bootstrap", d.bootstrap], { encoding: "utf8" });
  assert.equal(start.stdout, `launcher --bootstrap ${d.bootstrap}\n`, "the installed launcher runs from the install directory");
});

test("Linux: the secure default is not insecure-ws, the default install directory is /opt/reach-mcp-client, and the bootstrap is only a path", () => {
  const d = dirs();
  const result = run(["--archive", archive(), "--bootstrap", d.bootstrap, "--build", "b1", "--unit-dir", d.units, "--node", process.execPath, "--install-dir", d.install]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(path.join(d.units, "reach-mcp-client.service"), "utf8"), /allow-insecure-ws|^User=/m);
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^DEFAULT_INSTALL_DIR=\/opt\/reach-mcp-client$/m);
  assert.ok(!/reach-private|\/reach\/|packages\/client|\.env\b.*(cat|source|cp )/.test(script), "no PO-private path, source path or bootstrap read in the installer");
  assert.ok(!existsSync(d.bootstrap), "the installer never creates or copies the bootstrap");
});

test("Linux: unsafe or incomplete input exits 2 before touching the disk", () => {
  const d = dirs();
  const file = archive();
  const base = common(d, file);
  const swap = (flag: string, value: string) => base.map((v, i) => (base[i - 1] === flag ? value : v));
  const cases = [
    swap("--install-dir", ""),
    swap("--install-dir", "relative/dir"),
    swap("--install-dir", "/"),
    swap("--install-dir", "/usr"),
    swap("--install-dir", "/opt/../etc"),
    swap("--install-dir", "/opt/reach;rm"),
    swap("--bootstrap", "relative.env"),
    swap("--bootstrap", path.join(d.install, "bootstrap.env")),
    swap("--build", "bad id"),
    swap("--build", "-leading"),
    swap("--build", "a".repeat(129)),
    swap("--archive", path.join(d.root, "missing.tgz")),
    base.slice(0, 2),
  ];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.ok(!r.stderr.includes(LEAK_MARKER));
  }
  assert.ok(!existsSync(d.install) && !existsSync(d.units), "nothing was created");
});

test("Linux: a hostile archive (outside the top directory, a link) is refused", () => {
  const d = dirs();
  const withLink = archive("link.tgz", (top) => symlinkSync("/etc/passwd", path.join(top, "lib", "link")));
  assert.match(run(common(d, withLink)).stderr, /contains a link/);
  const other = mkdtempSync(path.join(base, "other-"));
  writeFileSync(path.join(other, "stray.txt"), "x");
  const outside = path.join(base, "outside.tgz");
  execFileSync("tar", ["-czf", outside, "-C", other, "stray.txt"]);
  assert.match(run(common(d, outside)).stderr, /outside reach-client\//);
  const noLauncher = path.join(base, "nolauncher.tgz");
  mkdirSync(path.join(other, "reach-client"));
  writeFileSync(path.join(other, "reach-client", "x.txt"), "x");
  execFileSync("tar", ["-czf", noLauncher, "-C", other, "reach-client"]);
  assert.match(run(common(d, noLauncher)).stderr, /no reach-client\/reach-client\.mjs launcher/);
  assert.ok(!existsSync(d.install), "no install from a refused archive");
});

test("Linux: reinstall replaces the previous runtime; a directory that is not a Client install is never replaced", () => {
  const d = dirs();
  assert.equal(run(common(d, archive())).status, 0);
  writeFileSync(path.join(d.install, "lib", "stale.txt"), "old");
  const second = archive("v2.tgz", (top) => writeFileSync(path.join(top, "lib", "marker.txt"), "v2"));
  assert.equal(run(common(d, second)).status, 0);
  assert.equal(readFileSync(path.join(d.install, "lib", "marker.txt"), "utf8"), "v2");
  assert.ok(!existsSync(path.join(d.install, "lib", "stale.txt")), "the old tree is gone, not merged");
  const foreign = dirs();
  mkdirSync(foreign.install, { recursive: true });
  writeFileSync(path.join(foreign.install, "precious.txt"), "keep");
  const r = run(common(foreign, archive()));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a REACH Client install/);
  assert.equal(readFileSync(path.join(foreign.install, "precious.txt"), "utf8"), "keep");
  assert.equal(statSync(path.join(d.units, "reach-mcp-client.service")).mode & 0o777, 0o644);
});

test("Windows (structural only, no PowerShell runs here): defaults, explicit override, quoting, no secret, no source checkout, no per-project artifact", () => {
  const ps = readFileSync(PS1, "utf8").replace(/^#.*$/gm, "");
  assert.match(ps, /\[string\]\$InstallDir = 'C:\\Program Files\\REACH\\Client'/, "platform default");
  assert.match(ps, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$Bootstrap/, "bootstrap is always an explicit, separate input");
  assert.match(ps, /Bootstrap must live outside the install directory/);
  assert.match(ps, /\$Arguments = "`"\$Launcher`" --bootstrap `"\$Bootstrap`" --build \$Build"/, "launcher and bootstrap paths are quoted (Program Files has a space)");
  assert.match(ps, /New-ScheduledTaskAction -Execute \$NodePath -Argument \$Arguments/);
  assert.match(ps, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(ps, /\$Arguments \+= ' --allow-insecure-ws'/);
  assert.match(ps, /\[switch\]\$AllowInsecureWs/, "the insecure switch is opt-in");
  assert.match(ps, /\$Top = 'reach-client'/);
  assert.match(ps, /Assert-AbsolutePath 'InstallDir'/);
  assert.doesNotMatch(ps, /credential|secret|REACH_CLIENT|Get-Content|\.env\b/i, "the script never reads the bootstrap or mentions a credential");
  assert.doesNotMatch(ps, /packages\\client|packages\/client|reach-private|\/reach\//, "no source checkout and no PO-private path");
  assert.doesNotMatch(ps, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/, "no download and no self-update");
  assert.equal([...ps.matchAll(/Register-ScheduledTask/g)].length, 2, "one Client per machine: the Client task and the one machine-level update task, never one per project");
  assert.match(ps, /-TaskName 'REACH Client Update'/, "the second task is the one-shot update task (no trigger)");
});

test("one Client install per machine: the install assets know no project and have no self-update", () => {
  for (const file of [SCRIPT, PS1]) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/project[_ -]?id|--project|-Project|\$Project/i.test(text.replace(/never per project/g, "")), `${path.basename(file)} has no per-project input`);
    assert.ok(!/curl|wget|Invoke-WebRequest|auto-?update|cron|timer/i.test(text.replace(/nothing here updates itself/g, "")), `${path.basename(file)} fetches nothing`);
  }
});

test("Windows public installer (structural only, no PowerShell runs here): explicit origin, manifest v2 selection, verified bytes, narrow ACL'd root, no identity, Bypass child for the low-level script", () => {
  const ps = readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", "install.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  assert.match(ps, /\$env:REACH_SERVER_ORIGIN/, "the origin is explicit");
  assert.match(ps, /AllowAutoRedirect = \$false/, "no redirect, so the origin cannot be switched");
  assert.match(ps, /schema_version -ne 2/);
  assert.match(ps, /\$_\.role -eq 'client' -and \$_\.os -eq 'win32' -and \$_\.arch -eq 'x64'/, "selected by role/os/arch, never by filename");
  assert.match(ps, /Get-FileHash .* SHA256/);
  assert.ok(ps.indexOf("Get-FileHash") < ps.indexOf("New-Item -ItemType Directory -Path $Create"), "integrity is verified before any machine change");
  assert.match(ps, /S-1-5-18.*S-1-5-32-544/, "only SYSTEM and Administrators on the state directory");
  assert.match(ps, /-ExecutionPolicy Bypass -File \$LowLevel/, "a default Windows client refuses to run a .ps1 file directly");
  assert.match(ps, /-AllowInsecureWs -Start/);
  assert.doesNotMatch(ps, /REACH_CLIENT_ID|REACH_CLIENT_IDENTITY_KEY|openssl|New-SelfSigned/i, "identity is the Client's alone");
  assert.doesNotMatch(ps, /winget|choco|nodejs\.org/i, "no uncontrolled runtime supply chain: Node comes from the verified archive");
  assert.doesNotMatch(ps, /Invoke-WebRequest|Invoke-RestMethod|\birm\b/, "only the origin-pinned fetch");
});

test("PowerShell scripts: no double-quoted string puts a scope-like ':' right after a variable (a parse error on Windows PowerShell 5.1, found natively)", () => {
  for (const file of ["install.ps1", "install-windows.ps1", "uninstall-windows.ps1"]) {
    const text = readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", file), "utf8");
    const risky = text.split("\n").filter((line) => /"[^"]*\$(?!env:)[A-Za-z_][A-Za-z0-9_]*:[^"]*"/.test(line) && !/^\s*#/.test(line));
    assert.deepEqual(risky, [], `${file}: use \${name} or $($name) before a colon`);
  }
});

test("Windows low-level installer (structural): a running Client is stopped before the swap and restarted if the swap fails", () => {
  const ps = readFileSync(PS1, "utf8").replace(/^\s*#.*$/gm, "");
  const stop = ps.indexOf("Stop-ScheduledTask");
  assert.ok(stop > 0 && stop < ps.indexOf("Move-Item -LiteralPath $InstallDir -Destination $Old"), "the task is stopped before the old tree is moved");
  assert.match(ps, /Stop-Process -Force/, "a node.exe started from the install is stopped too");
  assert.equal([...ps.matchAll(/Start-ScheduledTask -TaskName \$TaskName -ErrorAction SilentlyContinue/g)].length, 2, "restarted after a failed move and after a failed swap");
});

test("Windows lifecycle (structural only, no PowerShell runs here): a receipt-driven uninstaller removes only the REACH-owned task, runtime and state and keeps a custom root", () => {
  const dir = path.join(import.meta.dirname, "..", "deploy", "client");
  const un = readFileSync(path.join(dir, "uninstall-windows.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  for (const f of ["install.ps1", "install-windows.ps1", "uninstall-windows.ps1"]) assert.match(readFileSync(path.join(dir, f), "utf8"), /^\$ProgressPreference = 'SilentlyContinue'$/m, `${f} turns progress rendering off (Expand-Archive progress made the install take many minutes)`);
  assert.match(un, /install-receipt\.json/, "driven by the receipt");
  assert.match(un, /Unregister-ScheduledTask/);
  assert.match(un, /IndexOf\("`"\$InstallDir\\reach-client\.mjs`"", \[StringComparison\]::OrdinalIgnoreCase\) -lt 0/, "a task that does not run the exact recorded launcher path is refused, case-insensitively");
  assert.match(un, /StartsWith\(\$InstallDir \+ '\\'/, "only Node processes under the recorded install directory are stopped");
  const low = readFileSync(path.join(dir, "install-windows.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(low, /\$_\.Path -and \$_\.Path\.StartsWith/, "the process Path is never read twice: PowerShell 5.1 can return null on the second read");
  assert.equal(low.match(/\$p = \$_\.Path; \$p -and \$p\.StartsWith\(/g)?.length, 2, "both the stop filter and the wait loop read Path once and test the captured value");
  const pub = readFileSync(path.join(dir, "install.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  assert.match(pub, /-and \$Root -ne \[IO\.Path\]::GetPathRoot\(\$Root\)\) \{ \$Create \+= \$Root \}/, "a drive root is never passed to New-Item: it exists and C:\\ is not a creatable path");
  assert.doesNotMatch(pub, /New-Item[^\n]*\$StateDir, \$Root/, "state directory and root are not created together");
  assert.match(un, /if \(\[bool\]\$R\.owned\.root -and \$Root\.Length -gt 3\) \{ Remove-IfEmpty \$Root \}/, "the root goes only when REACH created it and it is empty, and a drive root never goes");
  assert.doesNotMatch(un, /Remove-Item[^\n]*\$Root[^\n]*-Recurse/, "no recursive deletion of a root");
  const ps = readFileSync(path.join(dir, "install.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  assert.match(ps, /\$OwnRoot = -not \(Test-Path -LiteralPath \$Root\)/, "ownership is decided before the first change");
  assert.match(ps, /uninstall first to change it/, "a conflicting root fails before any change");
  assert.match(ps, /install-receipt\.json/);
  assert.match(ps, /uninstall first to change REACH_INSTALL_DIR/, "a changed install directory fails before any change");
  assert.match(ps, /IndexOf\("`"\$\(\$InstallDir\.TrimEnd\('\\'\)\)\\reach-client\.mjs`"", \[StringComparison\]::OrdinalIgnoreCase\) -lt 0/, "the public installer proves a task by the exact launcher path");
  assert.ok(ps.indexOf("uninstall first to change REACH_INSTALL_DIR") < ps.indexOf("New-Item -ItemType Directory -Path $Create"), "the coordinate check precedes every machine change");
  assert.match(readFileSync(PS1, "utf8"), /IndexOf\("`"\$Launcher`"", \[StringComparison\]::OrdinalIgnoreCase\) -lt 0/, "the low-level installer proves a task by the exact launcher path");
  assert.match(readFileSync(PS1, "utf8"), /is not a REACH Client task: refusing to replace it/, "a foreign Scheduled Task is refused by the low-level installer too");
  assert.ok(ps.indexOf("is not a REACH Client task") > 0 && ps.indexOf("is not a REACH Client task") < ps.indexOf("New-Item -ItemType Directory -Path $Create"), "the public installer refuses a foreign task before creating any state or bootstrap");
});

const CLIENT_DIR = path.join(import.meta.dirname, "..", "deploy", "client");
const strip = (file: string) => readFileSync(path.join(CLIENT_DIR, file), "utf8").replace(/^\s*#.*$/gm, "");
/** The single-quoted regex literals of a PowerShell file that describe a plain drive path, as JavaScript regular expressions. */
const drivePatterns = (file: string) => [...strip(file).matchAll(/'(\^\[A-Za-z\]:[^']*\$)'/g)].map((m) => m[1]!);

test("Windows roots: no path-depth rule anywhere, a shallow root is valid, and a whole drive is refused until the operator confirms it", () => {
  for (const file of ["install.ps1", "install-windows.ps1", "uninstall-windows.ps1"]) {
    const text = strip(file);
    assert.doesNotMatch(text, /two segments|Count -ge 2|Count -lt 2|must not be a drive root/, `${file} has no depth heuristic`);
  }
  const ps = strip("install.ps1");
  assert.match(ps, /\$AllowWholeDrive = \$env:REACH_ALLOW_WHOLE_DRIVE -eq '1'/, "one explicit confirmation switch, the Windows counterpart of --allow-whole-disk");
  assert.match(ps, /WARNING: REACH_ROOT \$Root shares the WHOLE DRIVE/, "the warning names the whole drive");
  assert.match(ps, /to confirm it, set \$env:REACH_ALLOW_WHOLE_DRIVE=/, "the refusal says how to confirm");
  assert.ok(ps.indexOf("REACH_ALLOW_WHOLE_DRIVE -eq") > 0 && ps.indexOf("WHOLE DRIVE") < ps.indexOf("New-Item -ItemType Directory -Path $Create"), "the confirmation precedes every machine change");
  const root = /Format-Root \$Root/.test(ps);
  assert.ok(root && /\$RootJson = \$Root\.Replace/.test(ps) && /root = \$Root; task_name/.test(ps), "a drive root is kept as C:\\ in the bootstrap and the receipt, never the drive-relative C:");
  const low = strip("install-windows.ps1");
  assert.match(low, /\$segments \| Where-Object \{ \$_ -eq '' -or \$_ -eq '\.' -or \$_ -eq '\.\.' \}/, "installer-owned coordinates keep plain syntax: no empty, . or .. segment");
});

test("Windows path grammar is symmetric: the installer writes only what the uninstaller accepts, and both treat the same strings alike", () => {
  const install = drivePatterns("install.ps1");
  const uninstall = drivePatterns("uninstall-windows.ps1");
  assert.deepEqual([...new Set(install)].sort(), [...new Set(uninstall)].sort(), "the same two grammars (below a drive, or a whole drive) in both scripts");
  const [below, whole] = [install.find((p) => p.endsWith("+$"))!, install.find((p) => p.endsWith("*$"))!];
  const ok = (pattern: string, value: string) => new RegExp(pattern).test(value) && !/(^|\\)\.\.?(\\|$)|\\\\/.test(value);
  assert.ok(ok(whole, "C:\\scope") && ok(below, "C:\\scope"), "a shallow root is valid");
  assert.ok(ok(whole, "C:\\") && !ok(below, "C:\\"), "a drive root is valid only as the project root, never as a state or install directory");
  assert.ok(!ok(whole, "C:\\..\\x") && !ok(whole, "\\\\host\\share") && !ok(whole, "C:relative"), "relative segments, UNC and drive-relative forms stay refused");
});

const asRoot = process.getuid?.() === 0;
const SYSTEM_NODE = "/usr/local/bin/node";
function preflight(nodeDir: string) {
  const state = path.join(base, `pf-state-${path.basename(nodeDir)}`);
  const result = spawnSync("sh", [path.join(CLIENT_DIR, "install.sh"), "--server-origin", "http://127.0.0.1:1", "--state-dir", state, "--install-dir", path.join(base, "pf-install"), "--unit-dir", path.join(base, "pf-units"), "--test-no-system"], { encoding: "utf8", env: { PATH: `${nodeDir}:/usr/bin:/bin` } });
  return { result, state };
}

test("Linux preflight (structural): the service user's Node check runs before any account, directory, download or unit change", () => {
  const sh = strip("install.sh");
  const check = sh.indexOf("cannot run $node_bin");
  assert.ok(check > 0);
  for (const change of ['useradd', 'mkdir -p "$state_dir"', "fetch /release/manifest", "install-linux.sh"]) assert.ok(check < sh.indexOf(change), `the check precedes ${change}`);
  assert.match(sh, /"\$runuser_bin" -u "\$SERVICE_USER" -- "\$node_bin" -v/, "an existing account runs the exact Node itself");
  assert.match(sh, /"\$setpriv_bin" --reuid=65534 --regid=65534 --clear-groups sh -c '"\$1" -v' sh "\$node_bin"/, "an account that does not exist yet is stood in for by an unprivileged identity, nothing is created");
});

test("Linux preflight: a Node inside a directory the service user cannot traverse is refused before anything is created", { skip: !asRoot && "switching users needs root" }, () => {
  const private700 = mkdtempSync(path.join(base, "private-node-"));
  execFileSync("chmod", ["700", private700]);
  symlinkSync(process.execPath, path.join(private700, "node"));
  const { result, state } = preflight(private700);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /the service user reach-mcp cannot run .*\/node .*Nothing was changed\./s);
  assert.ok(!existsSync(state) && !existsSync(path.join(base, "pf-install")) && !existsSync(path.join(base, "pf-units")), "no state, install or unit directory was created");
});

test("Linux preflight: a system Node the service user can run passes the check and the installer goes on to the download", { skip: (!asRoot && "switching users needs root") || (!existsSync(SYSTEM_NODE) && "no /usr/local/bin/node on this host") }, () => {
  const { result } = preflight("/usr/local/bin");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not download http:\/\/127\.0\.0\.1:1\/release\/manifest/, "it got past the Node check to the first network step");
  assert.doesNotMatch(result.stderr, /cannot run/);
});

test("Linux update: the installer registers the privileged half (a path unit on the Client's marker and a one-shot service) beside the Client unit, and a rerun restarts the Client onto the new install", () => {
  const d = dirs();
  const result = run([...common(d, archive()), "--user", "dev"]);
  assert.equal(result.status, 0, result.stderr);
  const state = path.dirname(d.bootstrap);
  const pathUnit = readFileSync(path.join(d.units, "reach-mcp-client-update.path"), "utf8");
  assert.match(pathUnit, new RegExp(`^PathExists=${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/update/apply$`, "m"));
  assert.match(pathUnit, /^Unit=reach-mcp-client-update\.service$/m);
  const service = readFileSync(path.join(d.units, "reach-mcp-client-update.service"), "utf8");
  assert.match(service, /^Type=oneshot$/m);
  assert.doesNotMatch(service, /^User=/m, "the update half runs as root: the Client's own account cannot replace its install");
  assert.ok(service.includes(`ExecStart=/bin/sh "${d.install}/deploy/apply-update-linux.sh" --bootstrap "${d.bootstrap}" --install-dir "${d.install}" --unit-dir "${d.units}"`));
  assert.doesNotMatch(pathUnit + service, /curl|wget|http|credential|secret/i, "the units carry no URL and no secret");
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /systemctl enable "\$UNIT_NAME" "\$UPDATE_PATH"\n\s+systemctl restart "\$UNIT_NAME"/, "enabling restarts the Client so a rerun runs the new files");
});

test("Linux update: the privileged script reruns the public installer on the staged archive, consumes the request first, and always removes the staged file", () => {
  const apply = path.join(import.meta.dirname, "..", "deploy", "client", "apply-update-linux.sh");
  const text = readFileSync(apply, "utf8");
  assert.doesNotMatch(text, /curl|wget|tar |systemctl|chown|useradd/, "no install logic of its own: the installer is the one owner");
  for (const exitCode of [0, 2]) {
    const d = dirs();
    const state = path.dirname(d.bootstrap);
    mkdirSync(path.join(state, "update"), { recursive: true });
    mkdirSync(path.join(d.install, "deploy"), { recursive: true });
    writeFileSync(d.bootstrap, "REACH_SERVER_URL=ws://127.0.0.1:8787/client\nREACH_CLIENT_ID=x\n");
    writeFileSync(path.join(state, "update", "client.tgz"), "staged");
    writeFileSync(path.join(state, "update", "apply"), "");
    const log = path.join(state, "args.txt");
    writeFileSync(path.join(d.install, "deploy", "install.sh"), `printf '%s\\n' "$@" >"${log}"\nexit ${exitCode}\n`);
    const result = spawnSync("sh", [apply, "--bootstrap", d.bootstrap, "--install-dir", d.install, "--unit-dir", d.units], { encoding: "utf8" });
    assert.equal(result.status, exitCode, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["--server-origin", "http://127.0.0.1:8787", "--state-dir", state, "--install-dir", d.install, "--unit-dir", d.units, "--staged", path.join(state, "update", "client.tgz")]);
    assert.equal(existsSync(path.join(state, "update", "apply")), false, "the request is consumed, so a failure is never retried in a loop");
    assert.equal(existsSync(path.join(state, "update", "client.tgz")), false, "the staged archive never lingers");
  }
});

test("Linux update: public installer --staged is still verified against the manifest, and release archives carry the update scripts", () => {
  const installer = readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", "install.sh"), "utf8");
  assert.match(installer, /--staged\) staged="\$2"/);
  assert.match(installer, /cp "\$staged" "\$work\/client\.tgz"\nelse\n {2}fetch "\$download_path" "\$work\/client\.tgz"\nfi\nCHECK=/, "a staged archive skips only the download: the size and SHA-256 check runs on it");
  const release = readFileSync(path.join(import.meta.dirname, "..", "scripts", "release.ts"), "utf8");
  for (const file of ["install.sh", "apply-update-linux.sh", "install.ps1", "apply-update-windows.ps1"]) assert.ok(release.includes(`"${file}"`), `${file} is packaged in the Client archive`);
});

test("Windows update (structural only): the installer registers a trigger-less one-shot SYSTEM task whose script lives in the state directory, and the apply script reruns install.ps1 from a copy", () => {
  const ps = readFileSync(PS1, "utf8");
  assert.match(ps, /Register-ScheduledTask -TaskName 'REACH Client Update' -Action \$UpdateAction -Principal \$Principal/);
  assert.doesNotMatch(ps.split("\n").filter((l) => l.includes("'REACH Client Update'")).join("\n"), /-Trigger/, "never started by a trigger: only the Client runs it by name");
  assert.match(ps, /\$UpdateDir = Join-Path \(Split-Path -Parent \$Bootstrap\) 'update'/);
  const apply = readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", "apply-update-windows.ps1"), "utf8");
  assert.match(apply, /Copy-Item -LiteralPath \(Join-Path \$InstallDir 'deploy\\install\.ps1'\)/, "the installer runs from a copy: the install directory is moved aside while it works");
  assert.match(apply, /\$env:REACH_STAGED = \$Staged/);
  assert.doesNotMatch(apply, /Invoke-WebRequest|HttpWebRequest|Stop-ScheduledTask|Stop-Process/, "no download and no process control of its own");
  const installer = readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", "install.ps1"), "utf8");
  assert.match(installer, /if \(\$Staged\) \{ Copy-Item -LiteralPath \$Staged -Destination \$ArchiveFile \} else \{ Get-Release/, "a staged archive skips only the download; size and SHA-256 are still checked");
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "deploy", "client", "uninstall-windows.ps1"), "utf8"), /Unregister-ScheduledTask -TaskName 'REACH Client Update'/, "the uninstaller removes the update task too");
});

// ---- ADR-0005: the installers pin the Server public key on first use; an existing pin is never replaced from the http answer; recovery is explicit and out of band ----
const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(43);
const EPOCH_LINES = "REACH_RELEASE_EPOCH=7\nREACH_RELEASE_DIGEST=" + "d".repeat(64) + "\nREACH_ROTATION_GENERATION=2\n";

/** A stand-in Server serving a valid schema-v2 manifest, a real (stand-in) archive whose machine installer does nothing, and a configurable trust key. */
async function standInServer(trustKey: string | null, archiveFile?: string) {
  const bytes = archiveFile ? readFileSync(archiveFile) : Buffer.from("x");
  const entry = (arch: string) => ({ role: "client", os: "linux", arch, download_path: `/release/artifacts/reach-client-linux-${arch}.tgz`, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length });
  const manifest = JSON.stringify({ schema_version: 2, client: { build_id: "b-1" }, artifacts: [entry("x64"), entry("arm64")] });
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/release/manifest") return void res.writeHead(200, { "content-type": "application/json" }).end(manifest);
    if (req.url === "/release/trust-key") return void (trustKey === null ? res.writeHead(404).end() : res.writeHead(200).end(JSON.stringify({ public_key: trustKey })));
    if (req.url?.startsWith("/release/artifacts/")) return void res.writeHead(200).end(bytes);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}
/** The archive the installer extracts: only the machine installer it hands over to, which here just succeeds. */
function noopArchive(): string {
  return archive(`noop-${Math.random().toString(36).slice(2)}.tgz`, (top) => {
    mkdirSync(path.join(top, "deploy"), { recursive: true });
    writeFileSync(path.join(top, "deploy", "install-linux.sh"), "#!/bin/sh\nexit 0\n");
  });
}
type Run = { code: number | null; stderr: string; state: string; bootstrap: string };
const runInstaller = (port: number, options: { env?: Record<string, string>; args?: string[]; state?: string } = {}) =>
  new Promise<Run>((resolve) => {
    const state = options.state ?? path.join(base, `pin-state-${Math.random().toString(36).slice(2)}`);
    const args = [path.join(CLIENT_DIR, "install.sh"), "--server-origin", `http://127.0.0.1:${port}`, "--state-dir", state, "--install-dir", path.join(state, "..", "pin-install"), "--unit-dir", path.join(state, "..", "pin-units"), "--test-no-system", ...(options.args ?? [])];
    execFile("sh", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env } }, (error, _out, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr, state, bootstrap: path.join(state, "bootstrap.env") }));
  });
/** An existing bootstrap as a previous install left it (no receipt, so the installer leaves its root alone). */
function seedBootstrap(lines: string): string {
  const state = mkdtempSync(path.join(base, "seed-"));
  writeFileSync(path.join(state, "bootstrap.env"), `REACH_SERVER_URL=ws://127.0.0.1:1/client\nREACH_ROOTS=["${state}"]\nREACH_CLIENT_ID=m\nREACH_CLIENT_IDENTITY_KEY=k\n${lines}`, { mode: 0o600 });
  return state;
}
const bootstrapText = (state: string) => readFileSync(path.join(state, "bootstrap.env"), "utf8");

test("installer pin (executed): a fresh install pins the published key; a differing REACH_SERVER_TRUST_KEY stops it before anything is created or downloaded", async () => {
  const srv = await standInServer(KEY_A, noopArchive());
  try {
    const bad = await runInstaller(srv.port, { env: { REACH_SERVER_TRUST_KEY: KEY_B } });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /differs from REACH_SERVER_TRUST_KEY: nothing was pinned or installed/);
    assert.equal(existsSync(bad.state), false, "no state directory");
    assert.ok(!srv.seen.some((u) => u.includes("/artifacts/")), "no artifact was requested");
    const ok = await runInstaller(srv.port, { env: { REACH_SERVER_TRUST_KEY: KEY_A } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(readFileSync(ok.bootstrap, "utf8"), new RegExp(`^REACH_SERVER_TRUST_KEY=${KEY_A}$`, "m"));
    const tofu = await runInstaller(srv.port);
    assert.equal(tofu.code, 0, tofu.stderr);
    assert.match(readFileSync(tofu.bootstrap, "utf8"), new RegExp(`^REACH_SERVER_TRUST_KEY=${KEY_A}$`, "m"), "trust on first use pins what the Server publishes");
  } finally {
    await srv.close();
  }
});

test("installer pin (executed): a Server that publishes no valid trust key stops the install", async () => {
  for (const [name, key] of [["absent", null], ["bad shape", "short"]] as const) {
    const srv = await standInServer(key, noopArchive());
    try {
      const r = await runInstaller(srv.port);
      assert.notEqual(r.code, 0, name);
      assert.ok(/trust key/.test(r.stderr) || /could not download/.test(r.stderr), `${name}: ${r.stderr.slice(0, 120)}`);
      assert.ok(!srv.seen.some((u) => u.includes("/artifacts/")), `${name}: nothing was downloaded`);
    } finally {
      await srv.close();
    }
  }
});

test("installer pin (executed): a normal rerun with the same pin keeps epoch, digest and generation exactly; with a different published key it fails and leaves the bootstrap byte for byte", async () => {
  const same = await standInServer(KEY_A, noopArchive());
  const other = await standInServer(KEY_B, noopArchive());
  try {
    const state = seedBootstrap(`REACH_SERVER_TRUST_KEY=${KEY_A}\n${EPOCH_LINES}`);
    const before = bootstrapText(state);
    const rerun = await runInstaller(same.port, { state });
    assert.equal(rerun.code, 0, rerun.stderr);
    const after = bootstrapText(state);
    for (const line of EPOCH_LINES.trim().split("\n")) assert.ok(after.includes(line), `${line} survives a same-key rerun`);
    assert.ok(after.includes(`REACH_SERVER_TRUST_KEY=${KEY_A}`));
    assert.equal(after.split("\n").filter((l) => l.startsWith("REACH_SERVER_URL=")).length, 1);
    const frozen = bootstrapText(state);
    const mismatch = await runInstaller(other.port, { state });
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /differs from the one pinned/);
    assert.match(mismatch.stderr, /--recover-trust/, "the message names the explicit way out");
    assert.equal(bootstrapText(state), frozen, "the bootstrap is byte for byte what it was");
    assert.ok(!other.seen.some((u) => u.includes("/artifacts/")), "nothing was downloaded or installed");
    void before;
  } finally {
    await same.close();
    await other.close();
  }
});

test("installer pin (executed): explicit recovery needs the new key out of band and matching; only then the pin is replaced and the freshness state reset", async () => {
  const srv = await standInServer(KEY_B, noopArchive());
  try {
    const state = seedBootstrap(`REACH_SERVER_TRUST_KEY=${KEY_A}\n${EPOCH_LINES}`);
    const frozen = bootstrapText(state);
    const noKey = await runInstaller(srv.port, { state, args: ["--recover-trust"] });
    assert.notEqual(noKey.code, 0);
    assert.match(noKey.stderr, /needs REACH_SERVER_TRUST_KEY/);
    const wrongKey = await runInstaller(srv.port, { state, args: ["--recover-trust"], env: { REACH_SERVER_TRUST_KEY: KEY_A } });
    assert.notEqual(wrongKey.code, 0);
    assert.match(wrongKey.stderr, /differs from REACH_SERVER_TRUST_KEY/);
    const staged = await runInstaller(srv.port, { state, args: ["--recover-trust", "--staged", noopArchive()], env: { REACH_SERVER_TRUST_KEY: KEY_B } });
    assert.notEqual(staged.code, 0);
    assert.match(staged.stderr, /cannot be combined with --staged/);
    assert.equal(bootstrapText(state), frozen, "every refused recovery leaves the bootstrap untouched");
    const recovered = await runInstaller(srv.port, { state, args: ["--recover-trust"], env: { REACH_SERVER_TRUST_KEY: KEY_B } });
    assert.equal(recovered.code, 0, recovered.stderr);
    const text = bootstrapText(state);
    assert.equal(text.match(/^REACH_SERVER_TRUST_KEY=.*$/gm)?.length, 1);
    assert.ok(text.includes(`REACH_SERVER_TRUST_KEY=${KEY_B}`) && !text.includes(KEY_A));
    for (const key of ["REACH_RELEASE_EPOCH", "REACH_RELEASE_DIGEST", "REACH_ROTATION_GENERATION"]) assert.ok(!text.includes(`${key}=`), `${key} was reset with the pin`);
    assert.ok(text.includes("REACH_CLIENT_IDENTITY_KEY=k"), "the Client identity is untouched");
  } finally {
    await srv.close();
  }
});

test("installer pin (executed): a bootstrap from before pinning gets the pin once; an operator-triggered update never changes an existing pin and fails on a different published key", async () => {
  const arc = noopArchive();
  const a = await standInServer(KEY_A, arc);
  const b = await standInServer(KEY_B, arc);
  try {
    const legacy = seedBootstrap("");
    assert.ok(!bootstrapText(legacy).includes("REACH_SERVER_TRUST_KEY"));
    const first = await runInstaller(a.port, { state: legacy });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(bootstrapText(legacy).match(new RegExp(`^REACH_SERVER_TRUST_KEY=${KEY_A}$`, "gm"))?.length, 1);
    const pinned = seedBootstrap(`REACH_SERVER_TRUST_KEY=${KEY_A}\n${EPOCH_LINES}`);
    const frozen = bootstrapText(pinned);
    const update = await runInstaller(a.port, { state: pinned, args: ["--staged", arc] });
    assert.equal(update.code, 0, update.stderr);
    assert.ok(bootstrapText(pinned).includes(EPOCH_LINES.trim().split("\n")[0]!), "an update keeps the freshness state");
    const evil = await runInstaller(b.port, { state: pinned, args: ["--staged", arc] });
    assert.notEqual(evil.code, 0, "an update against a Server publishing another key fails closed");
    assert.match(evil.stderr, /differs from the one pinned/);
    void frozen;
  } finally {
    await a.close();
    await b.close();
  }
});

test("installer pin (structural): both installers fetch the key before any change, guard the pin and mirror the recovery switch; no verifier is invented in PowerShell 5.1", () => {
  const sh = strip("install.sh");
  assert.ok(sh.indexOf("fetch /release/trust-key") > sh.indexOf("fetch /release/manifest") && sh.indexOf("fetch /release/trust-key") < sh.indexOf("SELECT="), "fetched with the manifest, before anything is selected or changed");
  assert.ok(sh.indexOf("existing_pin") < sh.indexOf("SELECT="), "the pin comparison precedes every change");
  for (const counter of ["REACH_SERVER_TRUST_KEY", "REACH_RELEASE_EPOCH", "REACH_RELEASE_DIGEST", "REACH_ROTATION_GENERATION"]) assert.ok(sh.includes(`/^${counter}=/d`), `a replaced pin resets ${counter}`);
  assert.ok(sh.includes("--recover-trust"));
  const ps = strip("install.ps1");
  assert.ok(ps.includes("/release/trust-key") && ps.includes("differs from REACH_SERVER_TRUST_KEY"), "Windows fetches the key and checks the out-of-band one");
  assert.ok(ps.includes("REACH_SERVER_TRUST_KEY=$ServerKey"), "Windows writes the pin");
  assert.ok(ps.includes("REACH_RECOVER_TRUST") && ps.includes("cannot be combined with an update") && ps.includes("needs REACH_SERVER_TRUST_KEY"), "Windows mirrors the recovery switch and its conditions");
  assert.ok(ps.indexOf("$ExistingPin") < ps.indexOf("$Endpoint = "), "the Windows pin comparison precedes every machine change");
  assert.ok(ps.includes("differs from the one pinned in the bootstrap") && /\$ExistingPin -eq ''/.test(ps), "a changed key fails closed and a missing pin is added once");
  assert.doesNotMatch(ps, /Ed25519|ConvertFrom-SecureString|System\.Security\.Cryptography\.(ECDsa|RSA)/, "no signature verifier is invented in PowerShell 5.1: first install is explicit trust on first use");
});
