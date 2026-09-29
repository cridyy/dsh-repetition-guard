[CmdletBinding()]
param(
  [string]$HarnessHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$RuntimeDirectory,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profileDirectory = [IO.Path]::GetFullPath((Join-Path $HarnessHome 'profiles/web'))
$installedDirectory = [IO.Path]::GetFullPath((Join-Path $HarnessHome 'plugins/dsh-repetition-guard'))
$pluginsDirectory = [IO.Path]::GetFullPath((Join-Path $HarnessHome 'plugins'))
if (-not $installedDirectory.StartsWith($pluginsDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装目标不在预期插件目录内' }
if (-not (Test-Path -LiteralPath (Join-Path $profileDirectory 'cordis.patch.yml'))) { throw '未找到现有 Web profile，请先初始化 dsh web' }
if ($Rollback) {
  & node (Join-Path $PSScriptRoot 'profile-patch.mjs') rollback $profileDirectory
  if ($LASTEXITCODE -ne 0) { throw '回滚失败' }
  exit 0
}
if (-not $RuntimeDirectory) {
  $shim = (Get-Command dsh -ErrorAction Stop).Source
  $RuntimeDirectory = Join-Path (Split-Path $shim) 'node_modules/@deepseek-ai/dsh'
}
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
$runtimeNamespace = Join-Path $RuntimeDirectory 'node_modules/@deepseek-ai'
$llmManifest = Get-Content -LiteralPath (Join-Path $runtimeNamespace 'dsh-llm/package.json') -Raw | ConvertFrom-Json
if ($llmManifest.version -ne '0.1.5-rc.2') { throw "当前验证过的 LLM runtime 为 0.1.5-rc.2，本机为 $($llmManifest.version)；先验证兼容性再安装" }
New-Item -ItemType Directory -Path $installedDirectory -Force | Out-Null
foreach ($name in @('lib','tools','package.json','cordis.patch.yml','README.md')) {
  $item = Join-Path $sourceRoot $name
  if (-not (Test-Path -LiteralPath $item)) { throw "缺少发布文件 $name" }
  Copy-Item -LiteralPath $item -Destination $installedDirectory -Recurse -Force
}
$moduleDirectory = Join-Path $installedDirectory 'node_modules'
New-Item -ItemType Directory -Path $moduleDirectory -Force | Out-Null
$namespaceLink = Join-Path $moduleDirectory '@deepseek-ai'
if (Test-Path -LiteralPath $namespaceLink) {
  $link = Get-Item -LiteralPath $namespaceLink
  if ($link.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($link.Target) -ne [IO.Path]::GetFullPath($runtimeNamespace)) { throw '已有依赖目录不匹配，拒绝覆盖' }
} else {
  # Share the actual host module instance: the request identity uses a WeakSet.
  New-Item -ItemType Junction -Path $namespaceLink -Target $runtimeNamespace | Out-Null
}
$composedPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-guard-' + [guid]::NewGuid().ToString() + '.yml')
$oldDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = [IO.Path]::GetFullPath($HarnessHome)
  & node (Join-Path $RuntimeDirectory 'lib/bin.js') web --dump-config | Set-Content -LiteralPath $composedPath -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'dsh Web 配置预检失败' }
  & node (Join-Path $PSScriptRoot 'profile-patch.mjs') install $profileDirectory $installedDirectory $RuntimeDirectory $composedPath
  if ($LASTEXITCODE -ne 0) { throw '写入接入配置失败' }
  & node (Join-Path $RuntimeDirectory 'lib/bin.js') web --dump-config | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '接入后配置校验失败，可运行本脚本 -Rollback' }
} finally {
  $env:DSH_HOME = $oldDshHome
  if (Test-Path -LiteralPath $composedPath) { Remove-Item -LiteralPath $composedPath }
}
Write-Output "插件已安装：$installedDirectory"
Write-Output 'Web 配置已接入；下一次启动 dsh web 时生效。旧会话文件未处理。'
