// Machine-level Client install contract. Linux is executed for real against a temporary prefix with a stand-in archive (the real
// release archive is installed in `npm run check:release`). Windows is proved structurally only: no PowerShell or Task Scheduler
// runs here, so native execution on a Windows host remains an explicit evidence limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const SCRIPT = path.join(import.meta.dirname, "..", "deploy", "client", "install-linux.sh");
const PS1 = path.join(import.meta.dirname, "..", "deploy", "client", "install-windows.ps1");
const LEAK_MARKER = "client-credential-" + "Xk93Pq41";
const base = mkdtempSync(path.join(tmpdir(), "reach-install-"));

/** A stand-in for reach-client-linux-x64.tgz: the same top directory and launcher name, a launcher that proves it ran. */
function archive(name = "client.tgz", extra = undefined) {
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
const run = (args) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
const common = (d, file) => ["--archive", file, "--bootstrap", d.bootstrap, "--build", "dev-1", "--install-dir", d.install, "--unit-dir", d.units, "--node", process.execPath];

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
  const swap = (flag, value) => base.map((v, i) => (base[i - 1] === flag ? value : v));
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
  assert.equal([...ps.matchAll(/Register-ScheduledTask/g)].length, 1, "one Client per machine: exactly one task, never one per project");
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
  assert.ok(ps.indexOf("Get-FileHash") < ps.indexOf("New-Item -ItemType Directory -Path $StateDir"), "integrity is verified before any machine change");
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
  assert.match(un, /if \(\[bool\]\$R\.owned\.root\) \{ Remove-IfEmpty \$Root \}/, "the root goes only when REACH created it and it is empty");
  assert.doesNotMatch(un, /Remove-Item[^\n]*\$Root[^\n]*-Recurse/, "no recursive deletion of a root");
  const ps = readFileSync(path.join(dir, "install.ps1"), "utf8").replace(/^\s*#.*$/gm, "");
  assert.match(ps, /\$OwnRoot = -not \(Test-Path -LiteralPath \$Root\)/, "ownership is decided before the first change");
  assert.match(ps, /uninstall first to change it/, "a conflicting root fails before any change");
  assert.match(ps, /install-receipt\.json/);
  assert.match(ps, /uninstall first to change REACH_INSTALL_DIR/, "a changed install directory fails before any change");
  assert.match(ps, /IndexOf\("`"\$\(\$InstallDir\.TrimEnd\('\\'\)\)\\reach-client\.mjs`"", \[StringComparison\]::OrdinalIgnoreCase\) -lt 0/, "the public installer proves a task by the exact launcher path");
  assert.ok(ps.indexOf("uninstall first to change REACH_INSTALL_DIR") < ps.indexOf("New-Item -ItemType Directory -Path $StateDir"), "the coordinate check precedes every machine change");
  assert.match(readFileSync(PS1, "utf8"), /IndexOf\("`"\$Launcher`"", \[StringComparison\]::OrdinalIgnoreCase\) -lt 0/, "the low-level installer proves a task by the exact launcher path");
  assert.match(readFileSync(PS1, "utf8"), /is not a REACH Client task: refusing to replace it/, "a foreign Scheduled Task is refused by the low-level installer too");
  assert.ok(ps.indexOf("is not a REACH Client task") > 0 && ps.indexOf("is not a REACH Client task") < ps.indexOf("New-Item -ItemType Directory -Path $StateDir"), "the public installer refuses a foreign task before creating any state or bootstrap");
});
