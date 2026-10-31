$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskCache = Join-Path $taskWorkspace '.cache'
$taskTools = Join-Path $taskWorkspace '.tools'
foreach ($taskDirectory in @($taskCache, $taskTools, (Join-Path $taskCache 'tmp'), (Join-Path $taskCache 'home'), (Join-Path $taskCache 'appdata'), (Join-Path $taskCache 'localappdata'))) {
    New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
}
$env:AE_WORKSPACE = $taskWorkspace
$env:HOME = Join-Path $taskCache 'home'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $taskCache 'appdata'
$env:LOCALAPPDATA = Join-Path $taskCache 'localappdata'
$env:PSModuleAnalysisCachePath = Join-Path $env:LOCALAPPDATA ('PowerShell/ModuleAnalysisCache-' + $PSVersionTable.PSVersion.Major)
$env:TEMP = Join-Path $taskCache 'tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:XDG_CONFIG_HOME = Join-Path $taskCache 'config'
$env:XDG_DATA_HOME = Join-Path $taskCache 'data'
$env:XDG_CACHE_HOME = $taskCache
$env:XDG_STATE_HOME = Join-Path $taskCache 'state'
$env:CARGO_HOME = Join-Path $taskTools 'cargo'
$env:RUSTUP_HOME = Join-Path $taskTools 'rustup'
$env:CARGO_TARGET_DIR = Join-Path $taskCache 'cargo-target'
$env:npm_config_cache = Join-Path $taskCache 'npm'
$env:npm_config_prefix = Join-Path $taskTools 'npm'
$env:PNPM_HOME = Join-Path $taskTools 'pnpm'
$env:COREPACK_HOME = Join-Path $taskCache 'corepack'
$env:npm_config_store_dir = Join-Path $taskCache 'pnpm-store'
$env:UV_CACHE_DIR = Join-Path $taskCache 'uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $taskTools 'python'
$env:PIP_CACHE_DIR = Join-Path $taskCache 'pip'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $taskTools 'playwright'
$env:PYTHONPYCACHEPREFIX = Join-Path $taskCache 'pycache'
$env:DOTNET_CLI_HOME = Join-Path $taskCache 'dotnet'
$env:NUGET_PACKAGES = Join-Path $taskCache 'nuget'
$env:GIT_CONFIG_GLOBAL = Join-Path $taskCache 'gitconfig'
$env:CARGO_BUILD_JOBS = '4'
$taskLlvm = Join-Path $taskTools 'llvm-mingw-20261006-msvcrt-x86_64\bin'
$env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $taskLlvm + ';' + (Join-Path $taskTools 'mingw64\bin') + ';' + (Join-Path $taskTools 'node') + ';' + (Join-Path $taskTools 'npm') + ';' + $env:PATH
if (Test-Path -LiteralPath (Join-Path $taskLlvm 'clang.exe')) {
    $env:CC_x86_64_pc_windows_gnu = Join-Path $taskLlvm 'x86_64-w64-mingw32-clang.exe'
    $env:AR_x86_64_pc_windows_gnu = Join-Path $taskLlvm 'llvm-ar.exe'
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $taskLlvm 'x86_64-w64-mingw32-clang.exe'
    $taskRustNative = Join-Path $taskTools 'gnu-support'
    $env:LIBRARY_PATH = $taskRustNative
    $env:CARGO_ENCODED_RUSTFLAGS = '-L' + [char]31 + ('native=' + $taskRustNative)
}
$env:RTK_TEE_DIR = Join-Path $taskCache 'rtk\tee'
$env:RTK_DB_PATH = Join-Path $taskCache 'rtk\history.db'
$env:RTK_AUDIT_DIR = Join-Path $taskCache 'rtk\audit'
$env:NODE_COMPILE_CACHE = Join-Path $taskCache 'node-compile-cache'
