[CmdletBinding()]
param([string]$PackageDirectory)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/workspace-env.ps1')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

# Metadata only. The fixed final package is the sole traversal root, and an
# entry with any Win32 ReparsePoint attribute is recorded without enumeration.
$auditWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$auditExpectedRoot = [IO.Path]::GetFullPath((Join-Path $auditWorkspace 'artifacts/AE-Switch-portable-win-x64'))
$auditReparsePaths = [Collections.Generic.List[object]]::new()
$auditErrors = [Collections.Generic.List[object]]::new()
$auditFiles = 0
$auditDirectories = 0
$auditInspected = 0
$auditRootValidated = $false

try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
    if ($auditWorkspace -notmatch '^[Gg]:[\\/]' -or -not $auditWorkspace.Equals($env:AE_WORKSPACE, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The audit must run from the current G: workspace.'
    }
    $auditRoot = if ($PackageDirectory) { [IO.Path]::GetFullPath($PackageDirectory) } else { $auditExpectedRoot }
    $auditRoot = $auditRoot.TrimEnd([char[]]@('\', '/'))
    if (-not $auditRoot.Equals($auditExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Only the exact current final package directory is allowed.'
    }
    for ($auditAncestor = $auditRoot; $auditAncestor; $auditAncestor = [IO.Path]::GetDirectoryName($auditAncestor)) {
        $auditAttributes = [IO.File]::GetAttributes($auditAncestor)
        if (($auditAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $auditReparsePaths.Add([ordered]@{ path = $auditAncestor; attributes = [int]$auditAttributes; ancestor = $true })
            throw 'Package ancestors cannot use reparse points.'
        }
        if (($auditAttributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'Package ancestors must be ordinary directories.' }
    }
    $auditRootValidated = $true
    $auditPrefix = $auditRoot + [IO.Path]::DirectorySeparatorChar
    $auditPending = [Collections.Generic.Stack[string]]::new()
    $auditPending.Push($auditRoot)
    while ($auditPending.Count) {
        $auditCurrent = $auditPending.Pop()
        try {
            $auditCurrent = [IO.Path]::GetFullPath($auditCurrent)
            if (-not ($auditCurrent.Equals($auditRoot, [StringComparison]::OrdinalIgnoreCase) -or $auditCurrent.StartsWith($auditPrefix, [StringComparison]::OrdinalIgnoreCase))) {
                throw 'An enumerated path escaped the exact package directory.'
            }
            $auditRelative = [IO.Path]::GetRelativePath($auditRoot, $auditCurrent).Replace('\', '/')
            $auditAttributes = [IO.File]::GetAttributes($auditCurrent)
            $auditInspected++
            if (($auditAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $auditReparsePaths.Add([ordered]@{
                    path = $auditRelative
                    attributes = [int]$auditAttributes
                    directory = ($auditAttributes -band [IO.FileAttributes]::Directory) -ne 0
                    ancestor = $false
                })
                continue
            }
            if (($auditAttributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $auditDirectories++
                # Top-directory enumeration only; recursion is managed by this
                # stack after each child's own attributes have been checked.
                foreach ($auditEntry in [IO.Directory]::GetFileSystemEntries($auditCurrent)) {
                    $auditPending.Push($auditEntry)
                }
            } else {
                $auditFiles++
            }
        } catch {
            $auditErrors.Add([ordered]@{
                path = [IO.Path]::GetRelativePath($auditRoot, $auditCurrent).Replace('\', '/')
                errorType = $_.Exception.GetType().FullName
                hresult = $_.Exception.HResult
            })
        }
    }
} catch {
    # Error messages can contain caller-supplied paths. Retain only the error
    # type and code; no file content or unrestricted argument is printed.
    $auditErrors.Add([ordered]@{
        path = '.'
        errorType = $_.Exception.GetType().FullName
        hresult = $_.Exception.HResult
    })
}

$auditPassed = $auditRootValidated -and $auditReparsePaths.Count -eq 0 -and $auditErrors.Count -eq 0
[ordered]@{
    recordedAt = [DateTime]::UtcNow.ToString('o')
    packageDirectory = $auditExpectedRoot
    scope = 'Win32 FileAttributes metadata for the exact current G: final package; no file contents read.'
    packageRootVerified = $auditRootValidated
    inspectionMethod = 'Iterative DFS with top-directory enumeration and a ReparsePoint attribute check on every entry.'
    entriesInspected = $auditInspected
    ordinaryFiles = $auditFiles
    ordinaryDirectories = $auditDirectories
    reparsePointCount = $auditReparsePaths.Count
    reparsePaths = @($auditReparsePaths.ToArray() | Sort-Object { $_.path })
    reparseEntriesEnumerated = $false
    fileContentsRead = $false
    packageMutated = $false
    errorCount = $auditErrors.Count
    errors = @($auditErrors.ToArray() | Sort-Object { $_.path })
    passed = [bool]$auditPassed
} | ConvertTo-Json -Depth 6
if (-not $auditPassed) { exit 1 }
