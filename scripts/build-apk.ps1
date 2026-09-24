# pvault 安卓包构建脚本
#
# 作用：把仓库里的静态站点复制进安卓工程的 assets，然后调用 Gradle 打出 APK。
# 为什么用脚本而不是手动复制：assets/www 是「构建产物」，仓库里不存它，
# 免得同一份代码有两份副本、改了一边忘另一边。
#
# 用法：
#   pwsh -File scripts/build-apk.ps1              # 出 release 包
#   pwsh -File scripts/build-apk.ps1 -Debug       # 出 debug 包（快，但签名不同）
#
# 环境变量（都有默认值，全在 D 盘，不碰 C 盘）：
#   ANDROID_SDK_ROOT  默认 D:\temp\android\sdk
#   GRADLE_USER_HOME  默认 D:\temp\android\gradle-home
#   GRADLE_BIN        默认 D:\temp\android\gradle-8.9\bin\gradle.bat
#   JAVA_HOME         默认 D:\temp\android\jdk（若不存在则回退到系统 java）
#   PVAULT_KEYSTORE / PVAULT_STOREPASS / PVAULT_KEYALIAS / PVAULT_KEYPASS

param(
    [switch]$Debug
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $root 'android'
$assetsWww = Join-Path $androidDir 'app\src\main\assets\www'

# —— 环境（全部指向 D 盘）——
$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { 'D:\temp\android\sdk' }
$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { 'D:\temp\android\gradle-home' }
$gradleBin = if ($env:GRADLE_BIN) { $env:GRADLE_BIN } else { 'D:\temp\android\gradle-8.9\bin\gradle.bat' }
$localJdk = Join-Path 'D:\temp\android' 'jdk'

if (-not (Test-Path $gradleBin)) { throw "找不到 Gradle：$gradleBin" }
if (-not (Test-Path $sdkRoot)) { throw "找不到 Android SDK：$sdkRoot（先跑 scripts/setup-android.ps1）" }

$env:ANDROID_SDK_ROOT = $sdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:GRADLE_USER_HOME = $gradleHome
New-Item -ItemType Directory -Force -Path $gradleHome | Out-Null

# 优先用自带的独立 JDK，避免依赖别处安装的（比如 D:\abaqus 那个）被卸载后构建就断。
if (Test-Path $localJdk) {
    $env:JAVA_HOME = $localJdk
    Write-Host "JAVA_HOME = $localJdk"
} elseif ($env:JAVA_HOME) {
    Write-Host "JAVA_HOME = $env:JAVA_HOME（用系统已有的）"
} else {
    Write-Host "警告：没有设置 JAVA_HOME，Gradle 会去找系统 PATH 里的 java"
}

# —— 1. 铺静态资源 ——
Write-Host "`n=== 复制静态站点到 assets ===" -ForegroundColor Cyan
if (Test-Path $assetsWww) { Remove-Item $assetsWww -Recurse -Force }
New-Item -ItemType Directory -Force -Path $assetsWww | Out-Null

foreach ($f in @('index.html', 'manifest.webmanifest', 'sw.js')) {
    $src = Join-Path $root $f
    if (Test-Path $src) { Copy-Item $src $assetsWww; Write-Host "  $f" }
}
foreach ($d in @('app', 'styles', 'icons')) {
    $src = Join-Path $root $d
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $assetsWww $d) -Recurse
        $n = (Get-ChildItem (Join-Path $assetsWww $d) -Recurse -File).Count
        Write-Host "  $d/  ($n 个文件)"
    }
}

# 安卓壳里没有 Service Worker 的意义（资源本来就在本地），但 index.html 里注册了它。
# 留着无害：注册会失败并被页面忽略，不影响功能。
$total = (Get-ChildItem $assetsWww -Recurse -File | Measure-Object Length -Sum)
Write-Host ("共 " + $total.Count + " 个文件，" + [math]::Round($total.Sum / 1KB, 0) + " KB")

# —— 2. 构建 ——
$task = if ($Debug) { 'assembleDebug' } else { 'assembleRelease' }
Write-Host "`n=== Gradle $task ===" -ForegroundColor Cyan

Push-Location $androidDir
try {
    & $gradleBin $task --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败（退出码 $LASTEXITCODE）" }
} finally {
    Pop-Location
}

# —— 3. 收集产物 ——
$variant = if ($Debug) { 'debug' } else { 'release' }
$apkDir = Join-Path $androidDir "app\build\outputs\apk\$variant"
$apks = Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue
if (-not $apks) { throw "构建完成但没找到 APK：$apkDir" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
foreach ($apk in $apks) {
    $dest = Join-Path $dist $apk.Name
    Copy-Item $apk.FullName $dest -Force
    Write-Host ("`nAPK: " + $dest + "  (" + [math]::Round($apk.Length / 1MB, 2) + " MB)") -ForegroundColor Green
}
