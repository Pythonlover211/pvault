# 一次性安装安卓构建环境（全部落在 D 盘，不碰 C 盘）
#
# 装什么：Android commandline-tools + platform-tools + android-34 平台 + build-tools 34
# 为什么放 D:\temp\android：D 盘根目录不允许普通用户新建文件夹（ACL 限制），
# D:\temp 是可写的现成位置。想换成 D:\Android 的话，先用管理员权限把该目录建好并
# 授予写权限，再改这里和 build-apk.ps1 里的默认路径。
#
# 用法：pwsh -File scripts/setup-android.ps1

$ErrorActionPreference = 'Stop'

$base = 'D:\temp\android'
$sdk = Join-Path $base 'sdk'
$zip = Join-Path $base 'commandlinetools.zip'

if (-not (Test-Path $zip)) { throw "缺少 $zip，请先下载 commandline-tools" }

# —— 1. 解开 commandline-tools ——
# 注意压缩包内部的目录名就叫 cmdline-tools，而 sdkmanager 要求它位于
# <sdk>/cmdline-tools/latest/ 才肯认（否则报 "Could not determine SDK root"）。
$sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
    Write-Host "=== 解压 commandline-tools ===" -ForegroundColor Cyan
    $tmp = Join-Path $base 'cmdline-tools-extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    $inner = Join-Path $tmp 'cmdline-tools'
    if (-not (Test-Path $inner)) { throw "压缩包结构不符合预期：$tmp 下没有 cmdline-tools 目录" }
    Move-Item $inner (Join-Path $sdk 'cmdline-tools\latest') -Force
    Remove-Item $tmp -Recurse -Force
    Write-Host "  已就位: $sdkmanager"
} else {
    Write-Host "commandline-tools 已存在，跳过解压"
}

if (-not (Test-Path $sdkmanager)) { throw "解压后仍找不到 sdkmanager：$sdkmanager" }

$env:ANDROID_SDK_ROOT = $sdk
$env:ANDROID_HOME = $sdk

# —— 2. 接受许可 ——
Write-Host "`n=== 接受 SDK 许可 ===" -ForegroundColor Cyan
$yes = (1..20 | ForEach-Object { 'y' }) -join "`n"
$yes | & $sdkmanager --sdk_root=$sdk --licenses 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }

# —— 3. 安装组件 ——
Write-Host "`n=== 安装 SDK 组件 ===" -ForegroundColor Cyan
$packages = @(
    'platform-tools',
    'platforms;android-34',
    'build-tools;34.0.0'
)
$yes | & $sdkmanager --sdk_root=$sdk --install @packages 2>&1 |
    Where-Object { $_ -match 'done|Warning|Error|error|Install|Accept|%' } |
    Select-Object -Last 15 | ForEach-Object { Write-Host "  $_" }

# —— 4. 核对 ——
Write-Host "`n=== 核对安装结果 ===" -ForegroundColor Cyan
$checks = @(
    @{ Name = 'platform-tools (adb)';  Path = "$sdk\platform-tools\adb.exe" },
    @{ Name = 'android-34 平台';        Path = "$sdk\platforms\android-34\android.jar" },
    @{ Name = 'build-tools 34.0.0';     Path = "$sdk\build-tools\34.0.0\aapt2.exe" },
    @{ Name = 'sdkmanager';             Path = $sdkmanager }
)
$allOk = $true
foreach ($c in $checks) {
    $ok = Test-Path $c.Path
    if (-not $ok) { $allOk = $false }
    Write-Host ("  " + $(if ($ok) { 'OK  ' } else { '缺失' }) + "  " + $c.Name)
}

$size = (Get-ChildItem $sdk -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ("`nSDK 总体积: " + [math]::Round($size / 1MB, 0) + " MB  位于 $sdk")
if ($allOk) { Write-Host "环境就绪，可以跑 scripts/build-apk.ps1" -ForegroundColor Green }
else { Write-Host "有组件缺失，请检查上面的输出" -ForegroundColor Yellow }
