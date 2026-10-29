# Rollback guide — what to do if an update causes problems

There are four layers, from least to most drastic.

## 1. Roll back your data (restore points)
**Profile → Backup & rollback → Restore points → Restore**

Restore points are created automatically:
- before the first start of a new app version
- before every Strava sync
- before importing a backup file
- before changing heart-rate zones
- before loading demo rides
- before switching to the Classic version
- before rolling back (so a rollback can itself be undone)

You can also tap **Create** any time. The last 6 automatic and 6 manual points are kept.
Rides, chats, reviews and settings are restored; API keys and the Strava login are kept.
Telemetry streams are not stored in restore points (they never change and can be re-downloaded).

## 2. Roll back the app version (Classic v2)
**Profile → Backup & rollback → Open Classic version (v2)**

Switches to the previous interface, built into the same APK. It uses the same database, so your rides and chats are there.
The choice is remembered across restarts. Tap **Use v3** at the top of Classic to come back.

This works because v3 never changes the database schema version — see the rule in `www/js/app/db.js`.

## 3. Recovery screen (app won't start)
If the app fails to start twice in a row, or hangs on start, a recovery screen appears with:
- **Try again**
- **Open Classic version (v2)**
- **Roll back data to last restore point**
- **Export my data (JSON)**

It's in `www/js/recovery.js` and has no dependencies, so it works even if the main app is broken.

## 4. Reinstall an older APK
Android refuses to install an older version over a newer one. To go back to an older APK completely:
1. In the current app: **Profile → Export JSON** (save it to Files/Drive).
2. Uninstall Ride Partner.
3. Install the older APK (old builds are kept in `C:\dev\releases`; the original v2 source is in `C:\dev\backups\Ai-Training-Coach-v2-original`).
4. In the older app: **Restore JSON** and pick the exported file. Re-enter API keys and sign in to Strava again.
