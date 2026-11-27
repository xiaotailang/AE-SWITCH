function Import-ProductionCoreCleanup {
    $wrapper = Join-Path $e2eWorkspace 'scripts/verify-portable-e2e.ps1'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Production cleanup wrapper could not be parsed.' }
    $names = @('Assert-E2eLocalPath', 'Get-E2eNativeProcessById', 'Get-E2eNativeProcessPath',
        'Initialize-E2eNativeProcessInterop', 'Test-E2eNativeCreationTime', 'Assert-E2eNativeProcessesExited',
        'Test-E2eCleanupSharingViolation', 'Assert-E2eNativeCleanupRetryScope', 'Remove-E2eOwnedLockedFile',
        'Test-E2eCleanupDirectoryNotEmpty', 'Wait-E2eOwnedDirectoryRetry', 'Remove-E2eOwnedTree')
    foreach ($name in $names) {
        $definition = @($ast.FindAll({
            param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]
        }, $false) | Where-Object Name -CEQ $name)
        if ($definition.Count -ne 1) { throw 'Expected exactly one production cleanup function.' }
        $definition[0].Extent.Text
    }
}

function Assert-E2eNativeOwner {
    $ancestor = $e2eWorkspace
    while ($ancestor) {
        $attributes = [IO.File]::GetAttributes($ancestor)
        if (-not ($attributes -band [IO.FileAttributes]::Directory) -or
            ($attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The production cleanup workspace cannot be redirected.'
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $expected = [IO.Path]::GetFullPath((Join-Path $e2eWorkspace ('.cache/native-e2e-sandbox/' + $e2eIdentifier)))
    if ($e2eIdentifier -cnotmatch '^[a-f0-9]{32}$' -or $e2eSandbox -ine $expected -or
        $e2eCleanupNonce -cnotmatch '^[a-f0-9]{64}$') { throw 'Expected a fresh production core cleanup capability.' }
    $null = Assert-E2eLocalPath $e2eSandbox
    $null = Assert-E2eLocalPath $e2eMarker
    if ((Get-FileHash -LiteralPath $e2eMarker -Algorithm SHA256).Hash -ine $e2eNativeMarkerHash) {
        throw 'Production core owner marker bytes changed.'
    }
    $marker = [IO.File]::ReadAllText($e2eMarker) | ConvertFrom-Json -AsHashtable
    if ($marker.schemaVersion -ne 2 -or $marker.ownerId -cne $e2eIdentifier -or
        $marker.workspace -ine $e2eWorkspace -or $marker.purpose -cne 'Independent single-page production GUI eight-tool acceptance' -or
        $marker.autoCleanup.schemaVersion -ne 1 -or $marker.autoCleanup.mode -cne $e2eCleanupMode -or
        $marker.autoCleanup.nonce -cne $e2eCleanupNonce) {
        throw 'Production core owner marker does not grant this cleanup capability.'
    }
}

function Remove-ProductionCoreFixture {
    Assert-E2eNativeOwner
    # This check adds an external-reference gate to the Windows job accounting
    # supplied by the supervisor. Preparation has started no client processes.
    Initialize-E2eNativeProcessInterop
    Assert-E2eNativeProcessesExited
    Remove-E2eOwnedTree $e2eSandbox -LockRetryTimeoutMs 0
    if (Test-Path -LiteralPath $e2eSandbox) { throw 'Production core fixture remains after cleanup.' }
}

function Initialize-ProductionCoreJob {
    if ('AEProductionCoreJob' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class AEProductionCoreJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting result, int length, IntPtr returned);

    private readonly SafeFileHandle handle;
    public AEProductionCoreJob() {
        handle = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception();
    }
    public void Attach(IntPtr process) {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception();
    }
    public uint ActiveProcesses {
        get {
            Accounting result;
            if (!QueryInformationJobObject(handle, 1, out result, Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new Win32Exception();
            return result.ActiveProcesses;
        }
    }
    public void Dispose() { handle.Dispose(); }
}
'@
}
