[CmdletBinding()]
param(
    [string]$PackageDirectory,
    [string]$Repository,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'

# This internally verified bundle has no bound public distribution approval.
# Validate the concrete package before any future publishing implementation;
# never invoke gh or write to GitHub from this entry.
$parameters = @{ CheckOnly = $true; RequirePublicReady = $true }
if ($PackageDirectory) { $parameters.PackageDirectory = $PackageDirectory }
if ($Repository) {
    $configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../release-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $configuration.githubRepository -or $configuration.githubRepository -cne $Repository) {
        throw '修改版仓库尚未绑定或与当前源码不一致；未执行 GitHub 操作。'
    }
}
& (Join-Path $PSScriptRoot 'prepare-github-release.ps1') @parameters
if (-not $CheckOnly) { throw '当前入口只提供公共发布门检查；尚未执行或实现对外上传，不能当作发布成功。' }
