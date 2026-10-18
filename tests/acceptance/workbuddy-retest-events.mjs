import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Independent diagnostics only. A fresh run never replaces the failed portable
// acceptance receipt or relaxes its write/read/readback verification conditions.
const workspace = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const packageRoot = path.resolve(
  workspace,
  "artifacts/AE-Switch-portable-win-x64",
);
const credentialFile = path.resolve(workspace, "端点测试用.txt");
const sourceFile = path.resolve(
  workspace,
  "app/src-tauri/src/agent_verification.rs",
);
const historyFile = path.resolve(
  workspace,
  "artifacts/acceptance/retest-history/portable-e2e-fourth-marker-and-workbuddy-evidence.json",
);
const reportFile = path.resolve(
  workspace,
  "artifacts/acceptance/workbuddy-retest-events.json",
);
const base = path.resolve(workspace, ".cache/workbuddy-retest");
const ownerId = randomUUID();
const root = path.join(base, ownerId.replaceAll("-", ""));
const ownerFile = path.join(root, ".ae-workbuddy-retest-owner.json");
const purpose = "Independent WorkBuddy official event-schema diagnostics";
const nonce = randomUUID();
const directoryName = `.ae-tool-verification-${nonce}`;
const filename = `${directoryName}.txt`;
const marker = `AE_TOOL_VERIFIED_${nonce.replaceAll("-", "")}`;
const relativeArtifact = `${directoryName}/${filename}`;
const samePath = (left, right) =>
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const secrets = new Set();
let created = false;
let supervisorSucceeded = false;
let powershellExecutable;
let supervisorEnvironment;
const report = {
  recordedAt: new Date().toISOString(),
  sandboxRoot: root,
  ownerId,
  scope:
    "Fresh copied final CLI/Node/Git/WorkBuddy, real Rust discover/configure workbuddy, owned bridge, exact current verifier prompt and launcher arguments; independent from historical failed acceptance.",
  osSandboxEnabled: false,
  filename,
  marker,
  events: [],
  cleanup: { removed: false, ownerValidated: false, processesStopped: false },
};

async function assertPlain(location, allowMissing = false) {
  const absolute = path.resolve(location);
  assert.match(absolute, /^G:[\\/]/iu, "All diagnostic paths must stay on G:");
  const relative = path.relative(workspace, absolute);
  assert.ok(
    !relative.startsWith("..") && !path.isAbsolute(relative),
    "Diagnostic paths must stay in this workspace",
  );
  let current = absolute;
  while (current) {
    try {
      const info = await fs.lstat(current);
      assert.equal(
        info.isSymbolicLink(),
        false,
        "Diagnostic paths must not traverse links or junctions",
      );
      assert.ok(
        info.isFile() || info.isDirectory(),
        "Only ordinary local files and directories are eligible",
      );
      assert.ok(samePath(await fs.realpath(current), current));
    } catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

async function copyPlain(source, destination) {
  await assertPlain(source);
  await assertPlain(destination, true);
  const info = await fs.lstat(source);
  if (info.isDirectory()) {
    await fs.mkdir(destination);
    for (const name of await fs.readdir(source))
      await copyPlain(path.join(source, name), path.join(destination, name));
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    assert.equal((await fs.lstat(destination)).nlink, 1);
  }
}

function sanitize(text) {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret) text = text.split(secret).join("<redacted>");
  return text;
}

function safeJson(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "string" ? sanitize(item) : item),
    2,
  );
}

async function writeReport() {
  await assertPlain(reportFile, true);
  const serialized = safeJson(report);
  for (const secret of secrets)
    assert.equal(serialized.includes(secret), false);
  report.secretRedactionVerified = true;
  await fs.writeFile(reportFile, safeJson(report));
}

async function assertOwner() {
  await assertPlain(ownerFile);
  const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"));
  assert.equal(owner.id, ownerId);
  assert.equal(owner.purpose, purpose);
  assert.ok(samePath(owner.workspace, workspace));
  assert.ok(samePath(owner.root, root));
  assert.equal(owner.cliSha256, report.cliSha256);
  assert.ok(samePath(path.dirname(root), base));
  assert.match(path.basename(root), /^[a-f0-9]{32}$/u);
}

async function cleanupOwned() {
  await assertOwner();
  const audit = await new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable,
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        path.join(root, "supervisor.ps1"),
        "-SpecFile",
        path.join(root, "supervisor-spec.json"),
        "-AuditOnly",
      ],
      {
        cwd: root,
        env: supervisorEnvironment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      oversized = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (bytes) => {
      if (stdout.length + bytes.length > 8192) oversized = true;
      else stdout += bytes.toString();
    });
    child.stderr.on("data", (bytes) => {
      if (stderr.length + bytes.length > 8192) oversized = true;
      else stderr += bytes.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolve({ exitCode, stdout, stderr, oversized }),
    );
  });
  assert.equal(audit.exitCode, 0, sanitize(audit.stderr));
  assert.equal(audit.oversized, false);
  const auditReceipt = JSON.parse(audit.stdout);
  assert.equal(auditReceipt.ownerId, ownerId);
  assert.ok(samePath(auditReceipt.root, root));
  assert.equal(auditReceipt.cliSha256, report.cliSha256);
  assert.equal(auditReceipt.wholeTreeReparseAuditPassed, true);
  report.cleanup.win32AttributeAudit = auditReceipt;
  const files = [],
    directories = [],
    pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    await assertPlain(directory);
    directories.push(directory);
    for (const name of await fs.readdir(directory)) {
      const location = path.join(directory, name);
      await assertPlain(location);
      const info = await fs.lstat(location);
      if (info.isDirectory()) pending.push(location);
      else {
        assert.equal(info.nlink, 1);
        if (location !== ownerFile) files.push(location);
      }
    }
  }
  // A complete ordinary-file/reparse audit precedes every deletion. Remove only
  // this newly created UUID, using nonrecursive operations that fail closed.
  await assertOwner();
  for (const file of files) {
    await assertPlain(file);
    assert.equal((await fs.lstat(file)).nlink, 1);
    await fs.unlink(file);
  }
  for (const directory of directories.reverse())
    if (directory !== root) {
      await assertPlain(directory);
      await fs.rmdir(directory);
    }
  await assertOwner();
  await fs.unlink(ownerFile);
  await fs.rmdir(root);
  report.cleanup = {
    removed: true,
    ownerValidated: true,
    processesStopped: true,
    wholeTreeReparseAuditPassed: true,
    win32AttributeAudit: auditReceipt,
    nonRecursiveDirectoryRemoval: true,
    directoriesRemoved: directories.length,
    filesRemoved: files.length + 1,
    scope: "Only this newly created WorkBuddy retest UUID",
  };
}

// PowerShell 7 retains native handles for roots and observed descendants. It
// never kills by executable name or attaches to a pre-existing native session.
// All process evidence stays inside the fresh UUID until Node redacts it.
const supervisorSource = String.raw`
param([Parameter(Mandatory=$true)][string]$SpecFile, [switch]$AuditOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required for retained-handle process ownership.' }
$spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
$owned = @{}
$result = @{ processesStopped = $false; processIdentities = @(); identityFailure = $false; finalUuidProcessAuditPassed = $false }
$root = [IO.Path]::GetFullPath($spec.root)
$owner = Get-Content -LiteralPath (Join-Path $root '.ae-workbuddy-retest-owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($owner.id -ne $spec.ownerId -or $owner.root -ne $root -or $owner.cliSha256 -ne $spec.cliSha256) { throw 'Diagnostic supervisor owner mismatch.' }
if ((Get-FileHash -LiteralPath $spec.executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.cliSha256) { throw 'Diagnostic copied CLI hash mismatch.' }
foreach ($entry in $spec.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process') }
if ($AuditOnly) {
  # Read only: Windows reparse tags are rejected before descending into a tree.
  $ancestor = $root
  while ($ancestor) {
    if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'A cleanup ancestor has a Windows reparse attribute.' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  $count = 0
  while ($pending.Count) {
    $current = $pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($current)) {
      $absolute = [IO.Path]::GetFullPath($entry)
      if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Win32 cleanup audit escaped the new UUID.' }
      $attributes = [IO.File]::GetAttributes($absolute)
      if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Win32 cleanup audit refuses every reparse point.' }
      $count++
      if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($absolute) }
    }
  }
  @{ ownerId = $spec.ownerId; root = $root; cliSha256 = $spec.cliSha256; wholeTreeReparseAuditPassed = $true; entriesAudited = $count } | ConvertTo-Json -Compress
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class OwnedBoundedOutput {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = System.Runtime.InteropServices.CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
  private static extern bool QueryImage(IntPtr process, uint flags, StringBuilder name, ref uint size);
  public static string ExecutablePath(Process process) {
    var path = new StringBuilder(32768);
    uint size = 32768;
    if (!QueryImage(process.Handle, 0, path, ref size))
      throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
    return path.ToString();
  }
  public static async Task<string> Read(TextReader reader, Process process) {
    var buffer = new char[4096];
    var text = new StringBuilder();
    var size = 0;
    int count;
    while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0) {
      size += Encoding.UTF8.GetByteCount(buffer, 0, count);
      if (size > 2097152) {
        if (!process.HasExited) process.Kill();
        throw new InvalidDataException("Owned diagnostic output exceeded its bounded stream limit.");
      }
      text.Append(buffer, 0, count);
    }
    return text.ToString();
  }
  public static async Task<byte[]> ReadBytes(Stream reader, Process process) {
    var buffer = new byte[8192];
    using (var bytes = new MemoryStream()) {
      int count;
      while ((count = await reader.ReadAsync(buffer, 0, buffer.Length)) > 0) {
        if (bytes.Length + count > 2097152) {
          if (!process.HasExited) process.Kill();
          throw new InvalidDataException("Owned diagnostic output exceeded its bounded stream limit.");
        }
        bytes.Write(buffer, 0, count);
      }
      return bytes.ToArray();
    }
  }
  public static string DecodeBytes(byte[] bytes) {
    using (var reader = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false), true)) {
      return reader.ReadToEnd();
    }
  }
}
'@
function Test-OwnedExecutable([string]$location) {
  if ([string]::IsNullOrWhiteSpace($location)) { return $false }
  $absolute = [IO.Path]::GetFullPath($location)
  if ($absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  return @('WindowsPowerShell/v1.0/powershell.exe','cmd.exe','conhost.exe','where.exe') | Where-Object { $absolute.Equals((Join-Path ([Environment]::GetFolderPath('System')) $_), [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $true }
}
function Get-OwnedActualImage($process) { [OwnedBoundedOutput]::ExecutablePath($process) }
function Get-OwnedChildProcess([int]$processId) { Get-Process -Id $processId -ErrorAction Stop }
function Test-OwnedCreationTime([datetime]$actual, [datetime]$observed) {
  $actualTicks = $actual.ToUniversalTime().Ticks
  $observedTicks = $observed.ToUniversalTime().Ticks
  return ($actualTicks - $actualTicks % 10) -eq ($observedTicks - $observedTicks % 10)
}
function Get-OwnedSafeImage([string]$location) {
  if ([string]::IsNullOrWhiteSpace($location) -or $location -notmatch '^[A-Za-z]:[\\/]') { return @{ scope = 'unavailable'; name = $null } }
  $absolute = [IO.Path]::GetFullPath($location)
  $name = [IO.Path]::GetFileName($absolute)
  if ($name -notin @('bash.exe','git.exe','node.exe','WorkBuddy.exe','AE-Switch-core.exe','ae-switch-cli.exe','powershell.exe','cmd.exe','conhost.exe','where.exe')) { $name = 'other' }
  $scope = if ($absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { 'owned-root' } elseif (Test-OwnedExecutable $absolute) { 'allowed-system' } else { 'outside-owned-scope' }
  return @{ scope = $scope; name = $name }
}
function Get-OwnedNativeError($failure) {
  $exception = if ($failure -is [Management.Automation.ErrorRecord]) { $failure.Exception } else { $failure }
  while ($exception -and $exception.InnerException) { $exception = $exception.InnerException }
  if (-not $exception) { return $null }
  return @{ nativeErrorCode = if ($exception -is [ComponentModel.Win32Exception]) { $exception.NativeErrorCode } else { $null }; hresult = $exception.HResult; category = if ($exception -is [ComponentModel.Win32Exception]) { 'win32' } elseif ($exception -is [InvalidOperationException]) { 'invalid-operation' } elseif ($exception -is [ArgumentException]) { 'argument' } else { 'other' } }
}
function Add-OwnedChildDiagnostic($child, [bool]$knownBefore, [string]$disposition, $actualImage = '', $nativeError = $null) {
  if (-not $result.ContainsKey('childIdentityDiagnostics')) { $result.childIdentityDiagnostics = @() }
  $cimCreatedAt = if ($child.CreationDate) { $child.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  if (@($result.childIdentityDiagnostics | Where-Object { $_.pid -eq $child.ProcessId -and $_.cimCreatedAt -eq $cimCreatedAt -and $_.disposition -eq $disposition }).Count) { return }
  $name = [string]$child.Name
  if ($name -notin @('bash.exe','git.exe','node.exe','WorkBuddy.exe','AE-Switch-core.exe','ae-switch-cli.exe','powershell.exe','cmd.exe','conhost.exe','where.exe','SogouCloud.exe')) { $name = 'other' }
  if ($result.childIdentityDiagnostics.Count -ge 64) { $result.childIdentityDiagnostics = @($result.childIdentityDiagnostics | Select-Object -Last 63) }
  # Images are classified, never copied as private paths. No command lines,
  # exception messages, credentials, profile names or original bytes are logged.
  $safeActualImage = if ($actualImage -is [hashtable]) { $actualImage } else { Get-OwnedSafeImage $actualImage }
  $result.childIdentityDiagnostics += @{ pid = [int]$child.ProcessId; parentPid = [int]$child.ParentProcessId; name = $name; cimCreatedAt = $cimCreatedAt; knownBefore = $knownBefore; disposition = $disposition; cimImage = (Get-OwnedSafeImage $child.ExecutablePath); actualImage = $safeActualImage; nativeError = $nativeError; commandLineRecorded = $false }
}
function Assert-OwnedRetainedIdentity($identity) {
  $identity.process.Refresh()
  if ($identity.process.HasExited) { return $false }
  $identity.retainedExitNativeError = $null
  $started = $identity.process.StartTime
  if ($started -ne $identity.started) { throw 'Retained diagnostic process identity changed.' }
  try { $location = Get-OwnedActualImage $identity.process }
  catch [InvalidOperationException], [ComponentModel.Win32Exception] {
    $captureFailure = $_
    $identity.process.Refresh()
    if ($identity.process.HasExited) {
      # Only the original, already-proven handle can confirm this exit race.
      $identity.retainedExitNativeError = Get-OwnedNativeError $captureFailure
      return $false
    }
    throw $captureFailure
  }
  if (-not $location.Equals($identity.path, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-OwnedExecutable $location) -or ($identity.expectedProgram -and -not $location.Equals($identity.expectedProgram, [StringComparison]::OrdinalIgnoreCase))) { throw 'Retained diagnostic process identity changed.' }
  return $true
}
function Remember-Owned([Diagnostics.Process]$process, [datetime]$notBefore, [string]$expectedProgram = '', $observedChild = $null) {
  $duplicate = $false
  $location = $null
  $lastNativeError = $null
  try {
    if ($owned.ContainsKey($process.Id)) {
      $known = $owned[$process.Id]
      $duplicate = -not [Object]::ReferenceEquals($known.process, $process)
      if ($duplicate -and -not (Test-OwnedCreationTime $process.StartTime $known.started)) { throw 'A newly acquired PID does not match its retained creation time.' }
      if ($expectedProgram -and -not $known.path.Equals([IO.Path]::GetFullPath($expectedProgram), [StringComparison]::OrdinalIgnoreCase)) { throw 'A known PID does not match its expected program.' }
      $null = Assert-OwnedRetainedIdentity $known
      return
    }
    # Keep the handle returned for this exact process before any retry. Query
    # its kernel-recorded image instead of a loader-dependent MainModule/PID.
    $null = $process.Handle
    $identityStarted = Get-Date
    $identityDeadline = $identityStarted.AddSeconds(2)
    $started = $null
    $location = $null
    $result.identityCaptureFailure = $null
    while ((Get-Date) -lt $identityDeadline) {
      $process.Refresh()
      try {
        $started = $process.StartTime
        $location = Get-OwnedActualImage $process
      } catch [InvalidOperationException] {
        $lastNativeError = Get-OwnedNativeError $_
        $location = $null
      } catch [ComponentModel.Win32Exception] {
        $lastNativeError = Get-OwnedNativeError $_
        $location = $null
      }
      if ($started -and -not [string]::IsNullOrWhiteSpace($location)) { break }
      if ($process.HasExited) { throw 'Owned process exited before its actual startup identity could be proven.' }
      Start-Sleep -Milliseconds 25
    }
    if (-not $started -or [string]::IsNullOrWhiteSpace($location)) { throw 'Owned startup identity was not readable within the bounded two-second deadline.' }
    $location = [IO.Path]::GetFullPath($location)
    if ($started -lt $notBefore -or -not (Test-OwnedExecutable $location)) {
      $result.rejectedIdentity = @{ pid = $process.Id; image = (Get-OwnedSafeImage $location); startedAt = $started.ToUniversalTime().ToString('o'); notBefore = $notBefore.ToUniversalTime().ToString('o'); expectedImage = (Get-OwnedSafeImage $expectedProgram); executableScopePassed = [bool](Test-OwnedExecutable $location) }
      throw 'Unexpected process identity outside the owned executable scope.'
    }
    $expected = if ($expectedProgram) { [IO.Path]::GetFullPath($expectedProgram) } else { $null }
    if ($expected -and -not $location.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Spawned process image does not match its exact expected program.' }
    if ($observedChild -and (-not $observedChild.CreationDate -or -not (Test-OwnedCreationTime $started $observedChild.CreationDate) -or ($observedChild.ExecutablePath -and -not ([IO.Path]::GetFullPath($observedChild.ExecutablePath)).Equals($location, [StringComparison]::OrdinalIgnoreCase)))) { throw 'Unknown child CIM identity does not match its actual handle.' }
    $owned[$process.Id] = @{ process = $process; started = $started; path = $location; expectedProgram = $expected; identityWaitMs = [int]((Get-Date) - $identityStarted).TotalMilliseconds }
  } catch {
    # A process may already have started. Never claim cleanup or delete its UUID
    # when retaining/proving its identity failed, even if it subsequently exits.
    $result.identityFailure = $true
    $result.identityCaptureFailure = @{ pid = $process.Id; image = (Get-OwnedSafeImage $location); nativeError = if ($lastNativeError) { $lastNativeError } else { Get-OwnedNativeError $_ } }
    throw
  } finally { if ($duplicate) { $process.Dispose() } }
}
function Record-Children {
  $pending = [Collections.Generic.Queue[int]]::new()
  $visited = [Collections.Generic.HashSet[int]]::new()
  foreach ($knownId in @($owned.Keys)) { $pending.Enqueue([int]$knownId) }
  while ($pending.Count) {
    $parentId = $pending.Dequeue()
    if (-not $visited.Add($parentId)) { continue }
    $parent = $owned[$parentId]
    if (-not $parent) { continue }
    try { if (-not (Assert-OwnedRetainedIdentity $parent)) { continue } } catch { $result.identityFailure = $true; throw }
    foreach ($childInfo in Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId" -ErrorAction Stop) {
      $childId = [int]$childInfo.ProcessId
      $knownBefore = $owned.ContainsKey($childId)
      $child = $null
      $retained = $false
      $actualImage = ''
      $result.identityCaptureFailure = $null
      try {
        if ($knownBefore) {
          $known = $owned[$childId]
          if (-not $childInfo.CreationDate -or -not (Test-OwnedCreationTime $known.started $childInfo.CreationDate) -or ($childInfo.ExecutablePath -and -not ([IO.Path]::GetFullPath($childInfo.ExecutablePath)).Equals($known.path, [StringComparison]::OrdinalIgnoreCase))) { throw 'Observed child PID is not the original retained identity.' }
          # A known exited handle proves that original child is finished. Never
          # reacquire it by PID or query its image after exit just for a CIM row.
          if (-not (Assert-OwnedRetainedIdentity $known)) {
            Add-OwnedChildDiagnostic $childInfo $true 'known-original-exited' $known.path $known.retainedExitNativeError
            continue
          }
          $pending.Enqueue($childId)
          continue
        }
        $child = Get-OwnedChildProcess $childId
        Remember-Owned $child $parent.started '' $childInfo
        $actualImage = $owned[$childId].path
        $retained = [Object]::ReferenceEquals($owned[$childId].process, $child)
        $pending.Enqueue($childId)
      } catch {
        $nativeError = if ($result.identityCaptureFailure -and $result.identityCaptureFailure.pid -eq $childId) { $result.identityCaptureFailure.nativeError } else { Get-OwnedNativeError $_ }
        if (-not $actualImage -and $result.identityCaptureFailure -and $result.identityCaptureFailure.pid -eq $childId) { $actualImage = $result.identityCaptureFailure.image }
        Add-OwnedChildDiagnostic $childInfo $knownBefore $(if ($knownBefore) { 'known-pid-or-retained-identity-rejected' } else { 'unknown-child-identity-rejected' }) $actualImage $nativeError
        $result.identityFailure = $true
        throw
      } finally { if ($child -and -not $retained) { $child.Dispose() } }
    }
  }
}
function Start-Owned([string]$program, [string[]]$arguments, [switch]$CaptureRawStdout) {
  $program = [IO.Path]::GetFullPath($program)
  if (-not (Test-OwnedExecutable $program)) { throw 'Diagnostic refuses an unowned executable.' }
  $start = [Diagnostics.ProcessStartInfo]::new($program)
  $start.WorkingDirectory = $root
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
  $before = Get-Date
  $process = [Diagnostics.Process]::Start($start)
  Remember-Owned $process $before $program
  $stdout = if ($CaptureRawStdout) { [OwnedBoundedOutput]::ReadBytes($process.StandardOutput.BaseStream, $process) } else { [OwnedBoundedOutput]::Read($process.StandardOutput, $process) }
  return @{ process = $process; stdout = $stdout; stderr = [OwnedBoundedOutput]::Read($process.StandardError, $process); rawStdout = [bool]$CaptureRawStdout; started = $before }
}
function Stop-OwnedProcesses {
  $result.processesStopped = $false
  $result.finalUuidProcessAuditPassed = $false
  try { Record-Children } catch { $result.identityFailure = $true }
  foreach ($identity in @($owned.Values | Sort-Object started -Descending)) {
    $process = $identity.process
    if ($process.HasExited) { continue }
    try {
      $currentStarted = $process.StartTime
      $currentLocation = [OwnedBoundedOutput]::ExecutablePath($process)
      if ($currentStarted -ne $identity.started -or $currentLocation -ne $identity.path -or -not (Test-OwnedExecutable $currentLocation) -or ($identity.expectedProgram -and $currentLocation -ne $identity.expectedProgram)) { throw 'Diagnostic process ownership changed; refusing to stop it.' }
    } catch { $result.identityFailure = $true; throw }
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'Owned diagnostic process did not exit within cleanup deadline.' }
  }
  $result.processIdentities = @($owned.Values | ForEach-Object { @{ pid = $_.process.Id; startedAt = $_.started.ToUniversalTime().ToString('o'); path = $_.path; expectedProgram = $_.expectedProgram; identityWaitMs = $_.identityWaitMs; exited = $_.process.HasExited } })
  if (@($owned.Values | Where-Object { -not $_.process.HasExited }).Count) { throw 'An owned diagnostic process is still running.' }
  # Read-only audit catches surviving UUID processes missed between polls.
  # An audit match is evidence to retain the sandbox, never authority to kill.
  $remaining = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $PID -and (
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and $_.CommandLine.Replace('/', '\').Contains($root, [StringComparison]::OrdinalIgnoreCase)) -or
      ($owned.ContainsKey([int]$_.ParentProcessId) -and $_.CreationDate -ge $owned[[int]$_.ParentProcessId].started)
    )
  })
  $result.finalUuidProcessAudit = @($remaining | ForEach-Object { @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; path = $_.ExecutablePath; startedAt = $_.CreationDate } })
  if ($remaining.Count) { throw 'A live process still references the new UUID or an owned parent; refusing sandbox deletion.' }
  $result.finalUuidProcessAuditPassed = $true
  if ($result.identityFailure) { throw 'A process identity could not be proven; refusing sandbox deletion.' }
  $result.processesStopped = $true
}
function Complete-Capture($capture, [string]$name, [int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while (-not $capture.process.HasExited) {
    Record-Children
    if ((Get-Date) -ge $deadline) { Stop-OwnedProcesses; $result[$name] = @{ timedOut = $true }; throw 'Diagnostic process exceeded its bounded deadline.' }
    Start-Sleep -Milliseconds 150
  }
  if (-not $capture.stdout.Wait(5000) -or -not $capture.stderr.Wait(5000)) { Stop-OwnedProcesses; throw 'Owned diagnostic output pipes did not drain within the bounded deadline.' }
  $stdout = $capture.stdout.GetAwaiter().GetResult()
  $stderr = $capture.stderr.GetAwaiter().GetResult()
  if ($capture.rawStdout) {
    [IO.File]::WriteAllBytes((Join-Path $root "$name.stdout.raw"), $stdout)
    $stdout = [OwnedBoundedOutput]::DecodeBytes($stdout)
  }
  $bytes = [Text.Encoding]::UTF8.GetByteCount($stdout) + [Text.Encoding]::UTF8.GetByteCount($stderr)
  $result[$name] = @{ exitCode = $capture.process.ExitCode; timedOut = $false; outputLimit = $bytes -gt 2097152; durationMs = [int]((Get-Date) - $capture.started).TotalMilliseconds; capturedStdoutBytes = [Text.Encoding]::UTF8.GetByteCount($stdout); capturedStderrBytes = [Text.Encoding]::UTF8.GetByteCount($stderr) }
  if ($bytes -gt 2097152) { throw 'Diagnostic process output exceeded the retained evidence limit.' }
  [IO.File]::WriteAllText((Join-Path $root "$name.stdout"), $stdout, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $root "$name.stderr"), $stderr, [Text.UTF8Encoding]::new($false))
  return $stdout
}
try {
  $discovery = Complete-Capture (Start-Owned $spec.executable @('discover', $spec.credentials)) 'discovery' 120 | ConvertFrom-Json
  if ($result.discovery.exitCode -ne 0 -or -not $discovery.id) { throw 'Real Rust model discovery failed.' }
  $available = @($discovery.codexOptions.models | Where-Object enabled | ForEach-Object id)
  if (-not $available.Count) { throw 'Real Rust discovery returned no enabled models.' }
  $model = if ($spec.model) { [string]$spec.model } else { [string]$available[0] }
  if ($model -notin $available) { throw 'Requested diagnostic model was not actually discovered.' }
  $result.models = $available
  $result.model = $model
  $configured = Complete-Capture (Start-Owned $spec.executable @('configure', 'workbuddy', $discovery.id, $model)) 'configuration' 30 | ConvertFrom-Json
  if ($result.configuration.exitCode -ne 0 -or $configured.id -ne 'workbuddy') { throw 'Real Rust WorkBuddy configuration failed.' }
  $gateway = Get-Content -LiteralPath (Join-Path $root 'data/protocol-bridge.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $bridge = Start-Owned $spec.executable @('serve')
  $deadline = (Get-Date).AddSeconds(20)
  $ready = $false
  $readinessErrors = [Collections.Generic.List[string]]::new()
  $healthStatuses = [Collections.Generic.List[int]]::new()
  $listenerObservations = @()
  while (-not $bridge.process.HasExited -and (Get-Date) -lt $deadline) {
    Record-Children
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $gateway.port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $bridge.process.Id })
    $listenerObservations = @($listeners | ForEach-Object { @{ pid = $_.OwningProcess; port = $_.LocalPort } })
    if ($listeners.Count) {
      try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:$($gateway.port)/health" -Headers @{ Authorization = "Bearer $($gateway.token)" } -NoProxy -TimeoutSec 2
        $status = [int]$health.StatusCode
        if ($healthStatuses.Count -lt 8 -and -not $healthStatuses.Contains($status)) { $healthStatuses.Add($status) }
        # bridge::health returns NO_CONTENT after authenticating this exact token.
        $ready = $status -eq 204
      } catch { if ($readinessErrors.Count -lt 8) { $readinessErrors.Add($_.Exception.Message) } }
      if ($ready) { break }
    }
    Start-Sleep -Milliseconds 150
  }
  $result.bridgeStartup = @{ pid = $bridge.process.Id; port = $gateway.port; ready = $ready; exited = $bridge.process.HasExited; listeners = $listenerObservations; healthErrors = @($readinessErrors); healthStatuses = @($healthStatuses); expectedHealthStatus = 204 }
  if (-not $ready) { throw 'Only the new owned Rust bridge may serve this diagnostic.' }
  $result.bridge = @{ pid = $bridge.process.Id; ownListenerVerified = $true; port = $gateway.port }
  $launcher = Join-Path $root 'data/agents/workbuddy/launch.ps1'
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher) + @($spec.arguments)
  $null = Complete-Capture (Start-Owned (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe') $arguments -CaptureRawStdout) 'execution' 120
} catch {
  $result.error = $_.Exception.Message
} finally {
  try { Stop-OwnedProcesses } catch { $result.processCleanupError = $_.Exception.Message }
  if ($bridge) {
    foreach ($stream in @('stdout','stderr')) {
      if ($bridge[$stream].IsCompleted -and -not $bridge[$stream].IsFaulted) {
        [IO.File]::WriteAllText((Join-Path $root "bridge.$stream"), $bridge[$stream].GetAwaiter().GetResult(), [Text.UTF8Encoding]::new($false))
      }
    }
  }
  [IO.File]::WriteAllText((Join-Path $root 'supervisor-result.json'), ($result | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
if (-not $result.processesStopped) { exit 2 }
`;

function observedTools(events) {
  const observed = [];
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const kind = String(value.type ?? value.kind ?? "").toLowerCase();
      if (
        kind.includes("tool") ||
        ["command_execution", "file_change"].includes(kind)
      )
        observed.push(value);
      Object.values(value).forEach(visit);
    }
  }
  for (const event of events) {
    if (
      event.type === "user" ||
      event.role === "user" ||
      event.message?.role === "user"
    ) {
      const content = event.message?.content ?? event.content;
      if (Array.isArray(content))
        observed.push(
          ...content.filter(
            (block) => block.type === "tool_result" && toolId(block),
          ),
        );
    } else visit(event);
  }
  return observed;
}
const toolId = (value) =>
  ["toolCallId", "tool_call_id", "tool_use_id", "call_id", "id"]
    .map((key) => value[key])
    .find((item) => typeof item === "string");
const toolName = (value) =>
  ["name", "tool", "toolName", "tool_name"]
    .map((key) => value[key])
    .find((item) => typeof item === "string") ?? "";
function operations(value) {
  const name = toolName(value).toLowerCase(),
    kind = String(value.type ?? value.kind ?? "");
  const shell =
    kind === "command_execution" ||
    [
      "bash",
      "shell",
      "terminal",
      "execute",
      "execute_command",
      "shell_command",
      "terminal_tool",
    ].includes(name);
  const command = shell
    ? ([
        value.command,
        value.input?.command,
        value.arguments?.command,
        value.args?.command,
        value.cmd,
        value.input?.cmd,
        value.arguments?.cmd,
        value.args?.cmd,
      ]
        .find((item) => typeof item === "string")
        ?.toLowerCase() ?? "")
    : "";
  return {
    write:
      ["write", "edit", "write_file", "patch", "apply_patch"].includes(name) ||
      kind === "file_change" ||
      [
        "set-content",
        "writealltext",
        "out-file",
        "write_text",
        "writefile",
      ].some((text) => command.includes(text)) ||
      (command.includes(">") &&
        ["cat ", "printf "].some((text) => command.includes(text))),
    read:
      ["read", "read_file"].includes(name) ||
      [
        "get-content",
        "readalltext",
        "read_text",
        "readfile",
        "cat ",
        "type ",
      ].some((text) => command.includes(text)),
  };
}
function returnedMarker(value) {
  if (
    value.is_error === true ||
    value.isError === true ||
    value.success === false ||
    value.result?.success === false ||
    value.error != null ||
    value.state?.error != null
  )
    return false;
  if (
    [value.status, value.state?.status, value.result?.status].some((status) =>
      [
        "failed",
        "error",
        "cancelled",
        "canceled",
        "timed_out",
        "incomplete",
        "aborted",
        "denied",
      ].includes(status),
    )
  )
    return false;
  const kind = String(value.type ?? value.kind ?? ""),
    completedKind = ["result", "end", "completed"].some((text) =>
      kind.includes(text),
    );
  if (
    !completedKind &&
    value.status !== "completed" &&
    value.state?.status !== "completed"
  )
    return false;
  return [
    value.output,
    value.result,
    value.aggregated_output,
    value.state?.output,
    ...(completedKind ? [value.content] : []),
  ].some((item) => item != null && JSON.stringify(item).includes(marker));
}

function auditRawStdout(raw, decoded, events) {
  const strictDecoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  let strictUtf8Valid = true;
  try {
    strictDecoder.decode(raw);
  } catch {
    strictUtf8Valid = false;
  }
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const shapes = (event) =>
    observedTools(event && typeof event === "object" ? [event] : []).map(
      (value) => ({
        type: [
          "tool_use",
          "tool_result",
          "command_execution",
          "file_change",
        ].includes(value.type ?? value.kind)
          ? (value.type ?? value.kind)
          : "other_tool",
        name: ["Read", "Write", "Edit"].includes(toolName(value))
          ? toolName(value)
          : toolName(value)
            ? "other_tool"
            : "",
        hasId: Boolean(toolId(value)),
        relatedToFilename: JSON.stringify(value).includes(filename),
        ...operations(value),
        returnedMarker: returnedMarker(value),
      }),
    );
  const decodedLines = decoded.split(/\r?\n/u),
    invalidUtf8LineNums = [],
    toolEventLines = [];
  let lineNumber = 1,
    startByteOffset = 0;
  while (startByteOffset <= raw.length) {
    const newline = raw.indexOf(0x0a, startByteOffset),
      endByteOffset = newline < 0 ? raw.length : newline,
      line = raw.subarray(startByteOffset, endByteOffset);
    let strictLine = null;
    try {
      strictLine = strictDecoder.decode(line);
    } catch {
      invalidUtf8LineNums.push(lineNumber);
    }
    const strictEvent = strictLine === null ? null : parse(strictLine),
      replacementEvent = parse(decodedLines[lineNumber - 1] ?? ""),
      strictShapes = shapes(strictEvent),
      replacementShapes = shapes(replacementEvent);
    if (strictShapes.length || replacementShapes.length)
      toolEventLines.push({
        lineNumber,
        startByteOffset,
        byteLength: line.length,
        strictUtf8Valid: strictLine !== null,
        strictJsonParsed: strictEvent !== null,
        replacementJsonParsed: replacementEvent !== null,
        strictToolEventShapes: strictShapes,
        replacementToolEventShapes: replacementShapes,
      });
    if (newline < 0) break;
    startByteOffset = newline + 1;
    lineNumber += 1;
  }
  const replacementFields = [],
    publicFieldNames = new Set([
      "type",
      "kind",
      "message",
      "content",
      "input",
      "arguments",
      "file_path",
      "path",
      "filename",
      "name",
      "id",
      "tool_use_id",
      "thinking",
      "text",
      "result",
      "_meta",
      "output",
      "data",
      "role",
      "model",
    ]);
  function visit(value, fieldPath) {
    if (typeof value === "string") {
      const count = value.split("\uFFFD").length - 1;
      if (count) replacementFields.push({ fieldPath, count });
    } else if (Array.isArray(value))
      value.forEach((item, index) => visit(item, `${fieldPath}[${index}]`));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, item], index) =>
        visit(
          item,
          `${fieldPath}.${publicFieldNames.has(key) ? key : `<field-${index}>`}`,
        ),
      );
  }
  visit(events, "events");
  return {
    sha256: hash(raw),
    byteLength: raw.length,
    strictUtf8Valid,
    invalidUtf8LineCount: invalidUtf8LineNums.length,
    invalidUtf8LineNums,
    decodedReplacementCharacterCount: decoded.split("\uFFFD").length - 1,
    replacementFieldCount: replacementFields.length,
    parsedReplacementCharacterCount: replacementFields.reduce(
      (total, field) => total + field.count,
      0,
    ),
    replacementFields,
    toolEventLines,
    strictParser:
      "Fatal UTF-8 decoder plus JSON.parse; diagnostic only, not a serde_json acceptance result.",
    captureBoundary:
      "StandardOutput.BaseStream from Windows PowerShell running the Rust-generated WorkBuddy launch.ps1.",
    rawFileScope:
      "execution.stdout.raw stays inside the owned UUID until its existing cleanup.",
  };
}

try {
  assert.equal(process.platform, "win32");
  const foundPowerShell = spawnSync(
    path.join(process.env.SystemRoot, "System32/where.exe"),
    ["pwsh.exe"],
    { cwd: workspace, windowsHide: true, encoding: "utf8", maxBuffer: 8192 },
  );
  assert.equal(foundPowerShell.status, 0, "Existing PowerShell 7 is required");
  powershellExecutable = foundPowerShell.stdout.split(/\r?\n/u).find(Boolean);
  assert.ok(path.isAbsolute(powershellExecutable));
  assert.equal(path.basename(powershellExecutable).toLowerCase(), "pwsh.exe");
  assert.equal((await fs.lstat(powershellExecutable)).isFile(), true);
  assert.ok(
    samePath(await fs.realpath(powershellExecutable), powershellExecutable),
  );
  report.supervisorExecutable = {
    path: powershellExecutable,
    sha256: hash(await fs.readFile(powershellExecutable)),
    scope:
      "Existing PowerShell 7 read-only host; no installation or modification",
  };
  for (const location of [
    workspace,
    packageRoot,
    credentialFile,
    sourceFile,
    historyFile,
  ])
    await assertPlain(location);
  await assertPlain(base, true);
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, "package-manifest.json"), "utf8"),
  );
  report.packageManifestSha256 = hash(
    await fs.readFile(path.join(packageRoot, "package-manifest.json")),
  );
  const cliBytes = await fs.readFile(
    path.join(packageRoot, "AE-Switch-core.exe"),
  );
  report.cliSha256 = hash(cliBytes);
  assert.equal(
    report.cliSha256,
    manifest.cliSha256,
    "Current final CLI must match the final package manifest",
  );
  report.verifierSourceSha256 = hash(await fs.readFile(sourceFile));
  const historyBytes = await fs.readFile(historyFile);
  const oldReceipt = JSON.parse(historyBytes).agents.find(
    (agent) => agent.id === "workbuddy",
  );
  assert.equal(oldReceipt.passed, false);
  report.originalPortableFailurePreserved = {
    report: path.relative(workspace, historyFile),
    sha256: hash(historyBytes),
    result: oldReceipt.result,
    note: "This independent diagnostic does not rewrite or replace the fourth failed acceptance.",
  };
  const credentials = await fs.readFile(credentialFile, "utf8");
  for (const match of credentials.matchAll(/^\s*api-key[:：](.*)$/gmu)) {
    const key = match[1].trim();
    if (key) secrets.add(key);
  }
  assert.ok(
    [...secrets].some(Boolean),
    "Current local credentials are required",
  );
  await fs.mkdir(base, { recursive: true });
  await assertPlain(base);
  await fs.mkdir(root);
  created = true;
  await fs.writeFile(
    ownerFile,
    JSON.stringify({
      id: ownerId,
      purpose,
      workspace,
      root,
      cliSha256: report.cliSha256,
    }),
    { flag: "wx" },
  );
  await assertOwner();
  await fs.mkdir(path.join(root, "tools/agents"), { recursive: true });
  for (const relative of [
    "AE-Switch-core.exe",
    "tools/node",
    "tools/git",
    "tools/agents/workbuddy",
  ])
    await copyPlain(
      path.join(packageRoot, relative),
      path.join(root, relative),
    );
  for (const relative of ["vcruntime140.dll", "vcruntime140_1.dll"]) {
    try {
      await copyPlain(
        path.join(packageRoot, relative),
        path.join(root, relative),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const executable = path.join(root, "AE-Switch-core.exe");
  assert.equal(hash(await fs.readFile(executable)), report.cliSha256);
  report.copiedToolHashes = [];
  for (const relative of [
    "tools/node/node.exe",
    "tools/git/cmd/git.exe",
    "tools/agents/workbuddy/WorkBuddy.exe",
    "tools/agents/workbuddy/resources/app.asar.unpacked/cli/bin/codebuddy",
    "tools/agents/workbuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs",
  ]) {
    const source = path.join(packageRoot, relative),
      copied = path.join(root, relative);
    await assertPlain(source);
    await assertPlain(copied);
    const sourceSha256 = hash(await fs.readFile(source)),
      copiedSha256 = hash(await fs.readFile(copied));
    assert.equal(
      copiedSha256,
      sourceSha256,
      "Copied tool must match the current package",
    );
    report.copiedToolHashes.push({ relative, sourceSha256, copiedSha256 });
  }
  const ownedCredentials = path.join(root, "acceptance-credentials.txt");
  await fs.copyFile(
    credentialFile,
    ownedCredentials,
    fs.constants.COPYFILE_EXCL,
  );
  const ownedWorkspace = path.join(
    root,
    "data/agents/workbuddy/workspace",
    directoryName,
  );
  await fs.mkdir(ownedWorkspace, { recursive: true });
  await fs.writeFile(
    path.join(ownedWorkspace, ".ae-verification-owner"),
    nonce,
    { flag: "wx" },
  );
  const source = await fs.readFile(sourceFile, "utf8");
  assert.equal(hash(source), report.verifierSourceSha256);
  const template = source.match(
    /let mut prompt = format!\(\s*"([^"\r\n]*)"/u,
  )?.[1];
  assert.ok(
    template?.includes("{relative_artifact}") && template.includes("{marker}"),
  );
  const prompt = template
    .replaceAll("{relative_artifact}", relativeArtifact)
    .replaceAll("{marker}", marker);
  const argumentSource = source.slice(source.indexOf("fn arguments_for("));
  const argumentBody = argumentSource.match(
    /AgentId::WorkBuddy => vec!\[([\s\S]*?)\],/u,
  )?.[1];
  assert.ok(argumentBody);
  const argumentsForWorkbuddy = [
    ...argumentBody.matchAll(/"([^"\r\n]*)"|\bprompt\b/gu),
  ].map((match) => match[1] ?? prompt);
  assert.equal(
    argumentsForWorkbuddy.filter((value) => value === prompt).length,
    1,
  );
  report.promptSha256 = hash(prompt);
  report.arguments = argumentsForWorkbuddy;
  report.requestedModel = process.env.AE_TEST_MODEL ?? null;
  const environment = {
    ...Object.fromEntries(
      ["HOME", "USERPROFILE", "XDG_DATA_HOME"].map((name) => [
        name,
        path.join(root, "data/home"),
      ]),
    ),
    APPDATA: path.join(root, "data/home/AppData/Roaming"),
    LOCALAPPDATA: path.join(root, "data/home/AppData/Local"),
    XDG_CONFIG_HOME: path.join(root, "data/config"),
    XDG_CACHE_HOME: path.join(root, "data/cache"),
    XDG_STATE_HOME: path.join(root, "data/state"),
    DOTNET_CLI_HOME: path.join(root, "data/dotnet"),
    TEMP: path.join(root, "data/tmp"),
    TMP: path.join(root, "data/tmp"),
    TMPDIR: path.join(root, "data/tmp"),
    AE_SWITCH_PORTABLE_ROOT: root,
    AE_SWITCH_TOOLS_DIR: path.join(root, "tools/agents"),
    NO_PROXY: "localhost,127.0.0.1,::1",
    PATH: [
      path.join(process.env.SystemRoot, "System32"),
      process.env.SystemRoot,
      path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
    ].join(path.delimiter),
  };
  for (const location of new Set(
    Object.values(environment).filter(
      (value) => typeof value === "string" && value.startsWith(root),
    ),
  )) {
    await assertPlain(location, true);
    await fs.mkdir(location, { recursive: true });
  }
  environment.PSModuleAnalysisCachePath = path.join(
    environment.LOCALAPPDATA,
    "PowerShell/ModuleAnalysisCache-7",
  );
  await fs.mkdir(path.dirname(environment.PSModuleAnalysisCachePath), {
    recursive: true,
  });
  assert.equal(
    new Set(Object.keys(environment).map((name) => name.toLowerCase())).size,
    Object.keys(environment).length,
    "Windows supervisor environment must not repeat keys with different casing",
  );
  supervisorEnvironment = { ...process.env, ...environment };
  const specFile = path.join(root, "supervisor-spec.json"),
    scriptFile = path.join(root, "supervisor.ps1");
  await fs.writeFile(
    specFile,
    JSON.stringify({
      root,
      ownerId,
      cliSha256: report.cliSha256,
      executable,
      credentials: ownedCredentials,
      environment,
      model: report.requestedModel,
      arguments: argumentsForWorkbuddy,
    }),
    { flag: "wx" },
  );
  await fs.writeFile(scriptFile, supervisorSource, { flag: "wx" });
  await writeReport();
  const supervisor = await new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable,
      ["-NoLogo", "-NoProfile", "-File", scriptFile, "-SpecFile", specFile],
      {
        cwd: root,
        env: supervisorEnvironment,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (bytes) => {
      if (stderr.length < 8192) stderr += bytes.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({ pid: child.pid, exitCode, signal, stderr }),
    );
  });
  // Preserve startup failures, including errors before the supervisor's try /
  // finally, even when no supervisor-result.json could be written.
  report.supervisor = { ...supervisor };
  // The supervisor has already stopped every retained process before it exits.
  // Refuse UUID deletion if its identity checks or bounded cleanup failed.
  const result = JSON.parse(
    await fs.readFile(path.join(root, "supervisor-result.json"), "utf8"),
  );
  supervisorSucceeded =
    supervisor.exitCode === 0 &&
    result.processesStopped === true &&
    result.identityFailure === false &&
    result.finalUuidProcessAuditPassed === true;
  const gateway = JSON.parse(
    await fs.readFile(path.join(root, "data/protocol-bridge.json"), "utf8"),
  );
  if (gateway.token) secrets.add(gateway.token);
  report.supervisor = { ...supervisor, ...result };
  for (const stream of ["stdout", "stderr"]) {
    try {
      report[`bridge${stream}`] = await fs.readFile(
        path.join(root, `bridge.${stream}`),
        "utf8",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(
    supervisorSucceeded,
    true,
    "Owned process cleanup must be verified before deleting this UUID",
  );
  assert.equal(result.error, undefined, result.error);
  report.discovery = result.discovery;
  report.actualModels = result.models;
  report.model = result.model;
  report.execution = result.execution;
  report.bridgeProcess = result.bridge;
  const stdout = await fs.readFile(path.join(root, "execution.stdout"), "utf8");
  report.stderr = await fs.readFile(
    path.join(root, "execution.stderr"),
    "utf8",
  );
  report.events = stdout
    .split(/\r?\n/u)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  report.nonJsonLineCount = stdout.split(/\r?\n/u).filter(
    (line) =>
      line.trim() &&
      !report.events.some((event) => {
        try {
          return JSON.stringify(JSON.parse(line)) === JSON.stringify(event);
        } catch {
          return false;
        }
      }),
  ).length;
  const rawStdoutFile = path.join(root, "execution.stdout.raw");
  await assertPlain(rawStdoutFile);
  assert.equal((await fs.lstat(rawStdoutFile)).nlink, 1);
  report.rawStdout = auditRawStdout(
    await fs.readFile(rawStdoutFile),
    stdout,
    report.events,
  );
  const observed = observedTools(report.events),
    related = observed.filter((value) =>
      JSON.stringify(value).includes(filename),
    );
  const reads = related.filter((value) => operations(value).read),
    readIds = new Set(reads.map(toolId).filter(Boolean));
  const artifact = path.join(ownedWorkspace, filename);
  await assertPlain(artifact);
  assert.equal((await fs.lstat(artifact)).nlink, 1);
  assert.equal(
    await fs.readFile(
      path.join(ownedWorkspace, ".ae-verification-owner"),
      "utf8",
    ),
    nonce,
  );
  report.fileMatchesMarker = (await fs.readFile(artifact)).equals(
    Buffer.from(marker),
  );
  report.evidence = {
    eventCount: observed.length,
    relatedEventCount: related.length,
    writeObserved: related.some((value) => operations(value).write),
    readObserved: reads.length > 0,
    readbackMarkerObserved: observed.some(
      (value) =>
        ((JSON.stringify(value).includes(filename) && operations(value).read) ||
          readIds.has(toolId(value))) &&
        returnedMarker(value),
    ),
    assistantMarkerObserved: report.events.some(
      (event) =>
        event.type === "result" &&
        event.is_error !== true &&
        typeof event.result === "string" &&
        event.result.trim() === marker,
    ),
    fileMatchesMarker: report.fileMatchesMarker,
    processSucceeded:
      result.execution.exitCode === 0 &&
      !result.execution.timedOut &&
      !result.execution.outputLimit,
  };
  report.diagnosis = {
    observedToolNames: observed.map(toolName).filter(Boolean),
    offeredTools: report.events
      .filter((event) => event.type === "system" && event.subtype === "init")
      .flatMap((event) => event.tools ?? []),
    toolEventShapes: observed.map((value) => ({
      type: value.type ?? value.kind,
      name: toolName(value),
      id: toolId(value),
      keys: Object.keys(value),
      inputKeys: Object.keys(value.input ?? value.arguments ?? {}),
      relatedToFilename: JSON.stringify(value).includes(filename),
      ...operations(value),
      returnedMarker: returnedMarker(value),
    })),
    currentParserWouldVerify: Object.entries(report.evidence)
      .filter(([name]) => !["eventCount", "relatedEventCount"].includes(name))
      .every(([, value]) => value === true),
    sourceEvidence: [
      "app/src-tauri/src/agent_verification.rs:150",
      "app/src-tauri/src/agent_verification.rs:366",
      "app/src-tauri/src/agent_verification.rs:928",
      "tools/agents/workbuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs:495",
    ],
    gateChanged: false,
  };
} catch (error) {
  report.error = error.message;
} finally {
  if (created) {
    // Include the private loopback token in redaction even after failed setup.
    try {
      const gateway = JSON.parse(
        await fs.readFile(path.join(root, "data/protocol-bridge.json"), "utf8"),
      );
      if (gateway.token) secrets.add(gateway.token);
    } catch (error) {
      if (error.code !== "ENOENT") report.gatewayReadError = error.message;
    }
    await writeReport();
    if (supervisorSucceeded) {
      try {
        await cleanupOwned();
      } catch (error) {
        report.cleanup.error = error.message;
      }
    } else
      report.cleanup.note =
        "Retained because owned process cleanup was not independently confirmed; no directory deletion attempted.";
    await writeReport();
  }
}
console.log(
  safeJson({
    report: path.relative(workspace, reportFile),
    error: report.error,
    toolNames: report.diagnosis?.observedToolNames,
    evidence: report.evidence,
    cleanup: report.cleanup,
  }),
);
if (report.error || report.cleanup.removed !== true) process.exitCode = 1;
