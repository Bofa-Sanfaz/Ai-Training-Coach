#!/usr/bin/env node
// --------------------------------------------------------
// Applies Training Partner's native customisations to the generated
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
const APP_NAME = 'Training Partner';
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
// Health Connect: least privilege. The plugin declares read+write for ~24 data types;
// keep only the reads Training Partner uses, remove every write and unused read.
const HEALTH_KEEP = ['STEPS', 'HEART_RATE', 'WEIGHT', 'SLEEP', 'RESPIRATORY_RATE', 'OXYGEN_SATURATION', 'RESTING_HEART_RATE', 'HEART_RATE_VARIABILITY', 'VO2_MAX', 'EXERCISE', 'DISTANCE', 'ACTIVE_CALORIES_BURNED'];
const pluginManifest = path.join(root, 'node_modules', '@capgo', 'capacitor-health', 'android', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(pluginManifest)) {
  const perms = [...read(pluginManifest).matchAll(/android\.permission\.health\.([A-Z0-9_]+)/g)].map(m => m[1]);
  const remove = [...new Set(perms)].filter(p => p.startsWith('WRITE_') || !HEALTH_KEEP.includes(p.replace(/^READ_/, '')));
  if (!manifest.includes('xmlns:tools=')) manifest = manifest.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android"', '<manifest xmlns:android="http://schemas.android.com/apk/res/android"\n    xmlns:tools="http://schemas.android.com/tools"');
  manifest = manifest.replace(/\s*<!-- RP-HEALTH -->[\s\S]*?<!-- \/RP-HEALTH -->/, '');
  const block = `\n    <!-- RP-HEALTH -->\n    <uses-permission android:name="android.permission.health.READ_HEALTH_DATA_HISTORY" />\n${remove.map(p => `    <uses-permission android:name="android.permission.health.${p}" tools:node="remove" />`).join('\n')}\n    <!-- /RP-HEALTH -->`;
  manifest = manifest.replace('<!-- Permissions -->', `<!-- Permissions -->${block}`);
  log(`Health Connect: ${HEALTH_KEEP.length} read permissions kept, ${remove.length} removed`);
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

// 3) Min SDK 26 (Android 8.0) — required by the Health Connect plugin
const varsPath = path.join(root, 'android', 'variables.gradle');
if (fs.existsSync(varsPath)) {
  write(varsPath, read(varsPath).replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 26'));
  log('minSdkVersion 26');
}

// Version
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

// 7) Optional: Samsung Health swim reader (native/samsung-swims) — only when the Samsung
//    Health Data SDK is on this machine. Looked up in SHD_SDK_DIR, then C:\dev\tools\samsung-health-data-sdk.
//    The SDK can't be redistributed, so CI and other machines simply build without it.
const sdkDirs = [process.env.SHD_SDK_DIR, 'C:\\dev\\tools\\samsung-health-data-sdk'].filter(Boolean);
const findAar = dir => {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findAar(p); if (f) return f; }
    else if (/^samsung-health-data-api.*\.aar$/i.test(entry.name)) return p;
  }
  return null;
};
const aar = sdkDirs.map(findAar).find(Boolean);
const modDst = path.join(root, 'android', 'samsung-swims');
const settingsPath = path.join(root, 'android', 'settings.gradle');
const pluginsJson = path.join(main, 'assets', 'capacitor.plugins.json');
if (aar) {
  fs.rmSync(modDst, { recursive: true, force: true });
  copyDir(path.join(root, 'native', 'samsung-swims'), modDst);
  fs.mkdirSync(path.join(modDst, 'libs'), { recursive: true });
  const aarName = path.basename(aar);
  fs.copyFileSync(aar, path.join(modDst, 'libs', aarName));
  let settings = read(settingsPath);
  if (!settings.includes("':samsung-swims'")) settings += `\ninclude ':samsung-swims'\nproject(':samsung-swims').projectDir = new File('./samsung-swims/')\n`;
  write(settingsPath, settings);
  let g = read(gradlePath);
  if (!g.includes("project(':samsung-swims')")) {
    g = g.replace(/dependencies\s*\{/, `dependencies {\n    implementation project(':samsung-swims')\n    implementation files('../samsung-swims/libs/${aarName}')\n    implementation 'com.google.code.gson:gson:2.13.1'\n    implementation 'org.jetbrains.kotlin:kotlin-parcelize-runtime:2.4.21'\n    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0'`);
  }
  write(gradlePath, g);
  // Register the plugin with Capacitor (cap sync only lists npm plugins)
  const list = JSON.parse(read(pluginsJson));
  if (!list.some(p => p.classpath === 'app.trainingpartner.swims.SamsungSwimsPlugin')) list.push({ pkg: 'samsung-swims', classpath: 'app.trainingpartner.swims.SamsungSwimsPlugin' });
  write(pluginsJson, JSON.stringify(list, null, '\t'));
  // The SDK targets Android 10+; the app keeps minSdk 26 and only calls it on capable phones
  manifest = read(manifestPath);
  if (!manifest.includes('tools:overrideLibrary')) manifest = manifest.replace(/<uses-sdk[^>]*\/>/, '').replace('<application', '<uses-sdk tools:overrideLibrary="com.samsung.android.sdk.health.data" />\n\n    <application');
  write(manifestPath, manifest);
  log(`Samsung Health swim reader: included (${aarName})`);
} else {
  if (fs.existsSync(modDst)) fs.rmSync(modDst, { recursive: true, force: true });
  write(settingsPath, read(settingsPath).replace(/\ninclude ':samsung-swims'\nproject\(':samsung-swims'\)[^\n]*\n/, '\n'));
  write(gradlePath, read(gradlePath).replace(/\n\s*implementation project\(':samsung-swims'\)\n\s*implementation files\('\.\.\/samsung-swims[^\n]*\n\s*implementation 'com\.google\.code\.gson[^\n]*\n\s*implementation 'org\.jetbrains\.kotlin:kotlin-parcelize[^\n]*\n\s*implementation 'org\.jetbrains\.kotlinx[^\n]*/, ''));
  log('Samsung Health swim reader: SDK not found — built without it');
}

console.log('Android project patched.');
