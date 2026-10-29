# Building the APK

## Local (Windows) — one command
```
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1
```
Output: `C:\dev\releases\RidePartner-v<version>-<versionCode>.apk` and `C:\dev\releases\RidePartner-latest.apk`.

For the next local build, raise the version code so Android accepts it as an update:
```
powershell -ExecutionPolicy Bypass -File scripts\build-apk.ps1 -VersionCode 30001
```

The script uses the portable toolchain in `C:\dev\tools` (no system install):
| Tool | Path |
|------|------|
| Node.js 20 | `C:\dev\tools\node\node-v20.18.0-win-x64` |
| JDK 17 (Temurin) | `C:\dev\tools\jdk\jdk-17.*` |
| Android SDK (platform 34, build-tools 34) | `C:\dev\tools\android-sdk` |

Steps it runs: `npm install` → `npx cap add/sync android` → `node scripts/patch-android.js` → `gradlew assembleRelease` signed with `persistent-keystore.jks`.

## Signing
`persistent-keystore.jks` (alias `androiddebugkey`, password `android`) is the same key the GitHub build has always used,
so every APK installs as an update over the previous one and keeps the data.
It is a shared debug-grade key committed to the repo — fine for personal sideloading, **not** for the Play Store.

## Version codes
| Build | versionCode |
|-------|-------------|
| v2 GitHub builds | GitHub run number (small) |
| v3 local | 30000 (pass `-VersionCode` to raise) |
| v3 GitHub | 30000 + run number |

## GitHub Actions
`.github/workflows/build-apk.yml` builds on every push to `main` and uploads the APK as an artifact.

## Icons
Edit `www/img/logo.svg` (and `assets/logo-round.svg`, `assets/splash-logo.svg`, `android-res/drawable/ic_launcher_*.xml`), then:
```
powershell -ExecutionPolicy Bypass -File scripts\render-icons.ps1
```

## Previewing the web app on the PC
```
python -m http.server 8765 --directory www
```
Open http://localhost:8765 — use Profile → Diagnostics → Load demo rides to explore without Strava.
