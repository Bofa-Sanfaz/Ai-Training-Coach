#!/usr/bin/env node
// --------------------------------------------------------
// Applies Ride Partner's native customisations to the generated
// Capacitor project in ./android. Safe to run repeatedly.
// Used by scripts/build-apk.ps1 (local) and the GitHub workflow (CI).
//
//   VERSION_CODE env var → versionCode (default 30000; CI passes 30000 + run number)
//   package.json version  → versionName
// --------------------------------------------------------
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = path.join(root, 'android', 'app');
const main = path.join(app, 'src', 'main');
const res = path.join(main, 'res');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const APP_NAME = 'Ride Partner';
const versionCode = parseInt(process.env.VERSION_CODE || '30000', 10);
const versionName = pkg.version;

if (!fs.existsSync(main)) {
  console.error('android/ not found — run "npx cap add android" first.');
  process.exit(1);
}

const read = f => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s, 'utf8');
const log = m => console.log(`  ✓ ${m}`);

// 1) Manifest: deep link for Strava OAuth + resize for the keyboard
const manifestPath = path.join(main, 'AndroidManifest.xml');
let manifest = read(manifestPath);
if (!manifest.includes('android:scheme="aicoachv2"')) {
  manifest = manifest.replace(
    /(<\/intent-filter>)(\s*<\/activity>)/,
    `$1

            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="aicoachv2" android:host="aicoach.app" />
            </intent-filter>
$2`
  );
}
if (!manifest.includes('windowSoftInputMode')) {
  manifest = manifest.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:windowSoftInputMode="adjustResize"');
}
write(manifestPath, manifest);
log('AndroidManifest: Strava deep link + adjustResize');

// 2) App name
const stringsPath = path.join(res, 'values', 'strings.xml');
let strings = read(stringsPath)
  .replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">${APP_NAME}</string>`)
  .replace(/<string name="title_activity_main">.*?<\/string>/, `<string name="title_activity_main">${APP_NAME}</string>`);
write(stringsPath, strings);
log(`App name: ${APP_NAME}`);

// 3) Version
const gradlePath = path.join(app, 'build.gradle');
let gradle = read(gradlePath)
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);
write(gradlePath, gradle);
log(`Version: ${versionName} (${versionCode})`);

// 4) Remove Capacitor's default artwork (its drawable-v24 foreground would override ours on API 24+)
const removeIfExists = rel => {
  const p = path.join(res, rel);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
};
removeIfExists(path.join('drawable-v24', 'ic_launcher_foreground.xml'));
removeIfExists(path.join('drawable', 'splash.png'));
for (const dir of fs.readdirSync(res)) {
  if (/^drawable-(land|port)-/.test(dir)) fs.rmSync(path.join(res, dir), { recursive: true, force: true });
  if (/^mipmap-/.test(dir)) removeIfExists(path.join(dir, 'ic_launcher_foreground.png'));
}
log('Removed Capacitor default icon + splash artwork');

// 5) Copy our resources (android-res/** → res/**)
const srcRes = path.join(root, 'android-res');
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
};
copyDir(srcRes, res);
log('Copied launcher icons, adaptive/themed icon, splash');

// 6) Splash theme: brand background on Android 12+ splash API as well
const stylesPath = path.join(res, 'values', 'styles.xml');
let styles = read(stylesPath);
if (!styles.includes('windowSplashScreenBackground')) {
  styles = styles.replace(
    '<item name="android:background">@drawable/splash</item>',
    `<item name="android:background">@drawable/splash</item>
        <item name="windowSplashScreenBackground">@color/rp_splash_bg</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/ic_launcher_foreground</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>`
  );
}
write(stylesPath, styles);
log('Splash theme colours');

console.log('Android project patched.');
