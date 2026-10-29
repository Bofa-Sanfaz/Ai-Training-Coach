# --------------------------------------------------------
# One-command local APK build for Ride Partner.
#   powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 [-VersionCode 30001]
#
# Uses the portable toolchain in C:\dev\tools (Node 20, JDK 17, Android SDK),
# signs with persistent-keystore.jks (same key as the GitHub build, so it
# installs as an UPDATE over the existing app and keeps your data),
# and copies the result to C:\dev\releases.
# --------------------------------------------------------
param(
  [int]$VersionCode = 30000,
  [string]$Tools = 'C:\dev\tools',
  [string]$Releases = 'C:\dev\releases'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Capacitor 8 needs Node 22+ and JDK 21
$node = Get-ChildItem "$Tools\node22" -Directory | Select-Object -First 1
$jdk = Get-ChildItem "$Tools\jdk21" -Directory | Select-Object -First 1
if (-not $node -or -not $jdk) { throw "Toolchain missing in $Tools (node / jdk)." }
$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = "$Tools\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$($node.FullName);$($jdk.FullName)\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
$sdkmanager = "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat"

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step 'Android SDK packages'
if (-not (Test-Path "$env:ANDROID_HOME\platforms\android-36") -or -not (Test-Path "$env:ANDROID_HOME\build-tools\36.0.0")) {
  if (-not (Test-Path "$env:ANDROID_HOME\licenses\android-sdk-license")) {
    throw "Android SDK licenses not accepted yet. Run:  & '$sdkmanager' --licenses"
  }
  & $sdkmanager --install 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
}

Step 'npm dependencies'
if (-not (Test-Path 'node_modules\@capacitor\android')) { npm install --no-audit --no-fund }

Step 'Capacitor sync'
if (-not (Test-Path 'android')) { npx cap add android }
npx cap sync android
$env:VERSION_CODE = "$VersionCode"
node scripts/patch-android.js
Set-Content -Path 'android\local.properties' -Value ("sdk.dir=" + $env:ANDROID_HOME.Replace('\', '\\')) -Encoding ascii

Step 'Gradle assembleRelease'
$ks = Join-Path $root 'persistent-keystore.jks'
Push-Location android
try {
  .\gradlew.bat assembleRelease --no-daemon `
    "-Pandroid.injected.signing.store.file=$ks" `
    '-Pandroid.injected.signing.store.password=android' `
    '-Pandroid.injected.signing.key.alias=androiddebugkey' `
    '-Pandroid.injected.signing.key.password=android'
  if ($LASTEXITCODE -ne 0) { throw "Gradle build failed ($LASTEXITCODE)" }
} finally { Pop-Location }

Step 'Collect APK'
$version = (Get-Content package.json | ConvertFrom-Json).version
$apk = Get-ChildItem 'android\app\build\outputs\apk\release\*.apk' | Select-Object -First 1
if (-not $apk) { throw 'No APK produced.' }
New-Item -ItemType Directory -Force $Releases | Out-Null
$dest = Join-Path $Releases "RidePartner-v$version-$VersionCode.apk"
# Keep exactly one APK in releases: older builds move to backups\old-apks (rollback copies)
$archive = Join-Path (Split-Path $Releases -Parent) 'backups\old-apks'
Get-ChildItem $Releases -Filter '*.apk' | Where-Object { $_.FullName -ne $dest } | ForEach-Object {
  New-Item -ItemType Directory -Force $archive | Out-Null
  if ($_.Name -like '*latest*') { Remove-Item $_.FullName } else { Move-Item $_.FullName $archive -Force }
}
Copy-Item $apk.FullName $dest -Force
Write-Host "`nAPK ready: $dest ($([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB)" -ForegroundColor Green
