# --------------------------------------------------------
# Update Ride Partner on a USB-connected phone WITHOUT losing data.
#   powershell -ExecutionPolicy Bypass -File scripts\phone-update.ps1            # diagnose + update or back up
#   powershell -ExecutionPolicy Bypass -File scripts\phone-update.ps1 -Finish    # after a backup: reinstall + restore file
#
# 1. Tries a normal in-place update (keeps all data) and shows Android's exact reason if refused.
# 2. If the signing key differs, copies ALL app data (rides, streams, chats, settings - no API keys)
#    to C:\dev\backups and to the phone's Download folder. Nothing is uninstalled in this step.
# 3. -Finish: only after a verified backup - uninstalls the old app, installs the new APK and
#    leaves the backup in Download for Profile > Restore JSON.
# Phone: Settings > About phone > Software information > tap "Build number" 7x > Developer options >
#        USB debugging ON, connect by USB, accept the "Allow USB debugging" prompt.
# --------------------------------------------------------
param([switch]$Finish)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$adb = 'C:\dev\tools\android-sdk\platform-tools\adb.exe'
$node = (Get-ChildItem 'C:\dev\tools\node22' -Directory | Select-Object -First 1).FullName + '\node.exe'
$pkg = 'com.ridepartner.v2'
$apk = Get-ChildItem 'C:\dev\releases\*.apk' | Sort-Object LastWriteTime | Select-Object -Last 1
$backupDir = 'C:\dev\backups'
$backup = Join-Path $backupDir 'phone-rescue.json'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
# adb writes errors to stderr; capture them as text instead of letting PowerShell stop the script
function Adb {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $adb @args 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
  return ($out -join "`n")
}

Step 'Phone connection'
& $adb start-server | Out-Null
$devices = (Adb devices) -split "`n" | Where-Object { $_ -match "`t" }
if (-not $devices) { throw 'No phone found. Enable USB debugging, connect the cable, unlock the phone.' }
if ($devices -match 'unauthorized') { throw 'Phone is asking "Allow USB debugging?" - tap Allow, then run again.' }
Write-Host ($devices -join "`n")

Step 'Installed app'
$info = Adb shell dumpsys package $pkg
if ($info -notmatch 'versionCode') { Write-Host 'Ride Partner is not installed - installing fresh.'; Write-Host (Adb install $apk.FullName); exit 0 }
$ver = ([regex]::Match($info, 'versionName=(\S+)')).Groups[1].Value
$code = ([regex]::Match($info, 'versionCode=(\d+)')).Groups[1].Value
$debuggable = $info -match 'pkgFlags=\[[^\]]*DEBUGGABLE'
Write-Host "Installed: v$ver (code $code), debuggable: $debuggable"
Write-Host "New APK:   $($apk.Name)"

if ($Finish) {
  Step 'Finish: reinstall + restore file'
  if (-not (Test-Path $backup)) { throw "No backup at $backup - run without -Finish first." }
  $j = Get-Content $backup -Raw | ConvertFrom-Json
  Write-Host "Backup verified: $($j.workouts.Count) rides, $($j.streams.Count) streams, $($j.threads.Count) ride messages, $($j.master_chat.Count) coach messages"
  if ($j.workouts.Count -lt 1) { throw 'Backup contains no rides - refusing to uninstall.' }
  Write-Host (Adb uninstall $pkg)
  Write-Host (Adb install $apk.FullName)
  Write-Host (Adb push $backup '/sdcard/Download/RidePartner_Rescue.json')
  Adb shell monkey -p $pkg 1 | Out-Null
  Write-Host "`nDone. In the app: Profile > Backup & rollback > Restore JSON > Download > RidePartner_Rescue.json" -ForegroundColor Green
  Write-Host 'Then re-enter your Strava client secret / sign in, and your AI keys.' -ForegroundColor Green
  exit 0
}

Step 'Trying an in-place update (keeps all data)'
$res = Adb install -r $apk.FullName
Write-Host $res
if ($res -match 'Success') { Write-Host "`nUpdated in place - all data kept." -ForegroundColor Green; exit 0 }
if ($res -match 'VERSION_DOWNGRADE') { throw "The phone has a NEWER version code ($code). Rebuild with: scripts\build-apk.ps1 -VersionCode $([int]$code + 1)" }
if ($res -notmatch 'UPDATE_INCOMPATIBLE|signatures do not match|INCONSISTENT_CERTIFICATES') { throw 'Install refused for another reason (see above).' }

Write-Host "`nThe installed app was signed with a different key, so Android refuses an in-place update." -ForegroundColor Yellow
if (-not $debuggable) { throw 'The installed build is not debuggable, so data cannot be copied over USB. Use the old app''s own Export instead.' }

Step 'Copying all data out of the old app (nothing is changed on the phone)'
Adb shell monkey -p $pkg 1 | Out-Null
Start-Sleep -Seconds 5
$sock = ((Adb shell cat /proc/net/unix) -split "`n" | Select-String -Pattern '@(webview_devtools_remote_\d+)' | Select-Object -Last 1).Matches.Groups[1].Value
if (-not $sock) { throw 'Could not reach the app''s WebView - keep the app open on screen and run again.' }
Adb forward tcp:9333 "localabstract:$sock" | Out-Null
New-Item -ItemType Directory -Force $backupDir | Out-Null
& $node (Join-Path $root 'scripts\phone-rescue.js') 9333 $backup
if ($LASTEXITCODE -ne 0) { throw 'Data copy failed (see above). Nothing was changed on the phone.' }
Adb forward --remove tcp:9333 | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
Copy-Item $backup (Join-Path $backupDir "phone-rescue_$stamp.json")
Write-Host (Adb push $backup '/sdcard/Download/RidePartner_Rescue.json')

Write-Host "`nBACKUP COMPLETE - saved on this PC and in the phone's Download folder." -ForegroundColor Green
Write-Host 'Nothing was uninstalled. To finish: run this script again with -Finish (uninstalls old app, installs v3, then you tap Restore JSON).' -ForegroundColor Green
