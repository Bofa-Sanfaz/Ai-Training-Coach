// --------------------------------------------------------
// CRASH GUARD & RECOVERY SCREEN
// Loaded before everything else and has no dependencies, so it
// still works if the main app (or a library) fails to load.
//  - Counts boot attempts; main.js resets the counter on success.
//  - After 2 failed boots, or a boot that hangs, shows a recovery
//    screen: retry, switch to the Classic (v2) interface,
//    roll data back to the last restore point, or export raw data.
// --------------------------------------------------------
(function () {
  'use strict';
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  // Remembered UI choice: classic rollback build
  if (lsGet('rp_ui') === 'classic' && location.search.indexOf('modern') < 0) {
    location.replace('classic.html');
    return;
  }

  // Light is the default look; dark only when the rider picks it (or "System" on a dark phone)
  var theme = lsGet('rp_theme') || 'light';
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

  var fails = parseInt(lsGet('rp_boot_fail') || '0', 10) || 0;
  lsSet('rp_boot_fail', String(fails + 1));
  window.__rpSafeStart = fails >= 2;
  window.__rpBooted = false;
  window.__rpErrors = [];

  window.addEventListener('error', function (e) {
    if (!window.__rpBooted) window.__rpErrors.push(String((e && (e.message || (e.error && e.error.message))) || 'Unknown error'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (!window.__rpBooted) window.__rpErrors.push(String((e && e.reason && (e.reason.message || e.reason)) || 'Unhandled rejection'));
  });

  window.__rpBootOk = function () {
    window.__rpBooted = true;
    lsSet('rp_boot_fail', '0');
  };

  // Watchdog: a boot that never finishes counts as a failure
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!window.__rpBooted) window.__rpShowRecovery('The app did not finish starting.');
    }, 15000);
  });

  function idbOpen(name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbAll(dbh, store) {
    return new Promise(function (resolve, reject) {
      if (!dbh.objectStoreNames.contains(store)) { resolve([]); return; }
      var req = dbh.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function setStatus(msg) {
    var el = document.getElementById('rpRecoveryStatus');
    if (el) el.textContent = msg;
  }

  function exportRaw() {
    setStatus('Reading local database…');
    idbOpen('RidePartnerDB').then(function (dbh) {
      var tables = ['workouts', 'threads', 'master_chat', 'graph_threads', 'reports', 'config'];
      var dump = { app: 'RidePartner', version: 3, exported_at: new Date().toISOString(), recovery_export: true };
      var secret = ['gemini_api_key', 'strava_client_secret', 'strava_refresh_token', 'strava_access_token', 'strava_token_expires'];
      return tables.reduce(function (p, t) {
        return p.then(function () { return idbAll(dbh, t).then(function (rows) { dump[t] = rows; }); });
      }, Promise.resolve()).then(function () {
        dump.config = (dump.config || []).filter(function (c) { return secret.indexOf(c.key) < 0; });
        return JSON.stringify(dump);
      });
    }).then(function (json) {
      var name = 'RidePartner_Recovery_' + new Date().toISOString().slice(0, 10) + '.json';
      var P = window.Capacitor && window.Capacitor.Plugins;
      if (P && P.Filesystem && P.Share) {
        return P.Filesystem.writeFile({ path: name, data: json, directory: 'CACHE', encoding: 'utf8' })
          .then(function (r) { return P.Share.share({ title: name, files: [r.uri] }); })
          .then(function () { setStatus('Export ready: ' + name); });
      }
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setStatus('Export downloaded: ' + name);
    }).catch(function (e) { setStatus('Export failed: ' + (e && e.message)); });
  }

  function rollbackData() {
    if (!window.confirm('Replace your rides, chats and settings with the most recent restore point? (API keys and Strava login are kept.)')) return;
    setStatus('Opening restore points…');
    var snapshot;
    idbOpen('RidePartnerRestorePoints').then(function (rdb) {
      return idbAll(rdb, 'snapshots');
    }).then(function (snaps) {
      if (!snaps.length) throw new Error('No restore points found on this device.');
      snaps.sort(function (a, b) { return b.id - a.id; });
      snapshot = JSON.parse(snaps[0].data);
      return idbOpen('RidePartnerDB');
    }).then(function (dbh) {
      var tables = ['workouts', 'threads', 'master_chat', 'graph_threads', 'reports', 'config'];
      return idbAll(dbh, 'config').then(function (cfg) {
        var keep = cfg.filter(function (c) { return /gemini_api_key|strava_/.test(c.key); });
        return new Promise(function (resolve, reject) {
          var tx = dbh.transaction(tables, 'readwrite');
          tables.forEach(function (t) {
            var st = tx.objectStore(t);
            st.clear();
            (snapshot[t] || []).forEach(function (row) { st.put(row); });
          });
          keep.forEach(function (row) { tx.objectStore('config').put(row); });
          tx.oncomplete = resolve;
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }).then(function () {
      setStatus('Data rolled back. Restarting…');
      lsSet('rp_boot_fail', '0');
      setTimeout(function () { location.reload(); }, 800);
    }).catch(function (e) { setStatus('Rollback failed: ' + (e && e.message)); });
  }

  window.__rpShowRecovery = function (reason) {
    if (document.getElementById('rpRecovery')) return;
    var errs = (window.__rpErrors || []).slice(-3).join('\n');
    var box = document.createElement('div');
    box.id = 'rpRecovery';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:9999;background:#0a101d;color:#e7edf8;overflow:auto;padding:calc(env(safe-area-inset-top) + 28px) 20px 28px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;');
    var btn = 'display:block;width:100%;padding:13px;border-radius:12px;border:none;font-weight:700;font-size:15px;margin-top:10px;';
    box.innerHTML =
      '<div style="max-width:460px;margin:0 auto;">' +
      '<div style="font-size:40px;">🛟</div>' +
      '<h2 style="margin:8px 0 6px;font-size:22px;">Recovery mode</h2>' +
      '<p style="color:#9fb0cf;font-size:14px;line-height:1.5;margin:0 0 6px;">' + (reason || 'Ride Partner had trouble starting.') + ' Your data is stored on this phone and has not been deleted. Choose an option:</p>' +
      (errs ? '<pre style="white-space:pre-wrap;background:#111a2c;color:#f87171;padding:10px;border-radius:10px;font-size:11px;">' + errs.replace(/</g, '&lt;') + '</pre>' : '') +
      '<button id="rpRetry" style="' + btn + 'background:#fc5200;color:#fff;">Try again</button>' +
      '<button id="rpClassic" style="' + btn + 'background:#1b2842;color:#fff;">Open Classic version (v2)</button>' +
      '<button id="rpRollback" style="' + btn + 'background:#1b2842;color:#fff;">Roll back data to last restore point</button>' +
      '<button id="rpExport" style="' + btn + 'background:#1b2842;color:#fff;">Export my data (JSON)</button>' +
      '<p id="rpRecoveryStatus" style="color:#38bdf8;font-size:13px;margin-top:14px;"></p>' +
      '</div>';
    document.body.appendChild(box);
    document.getElementById('rpRetry').onclick = function () { lsSet('rp_boot_fail', '0'); location.reload(); };
    document.getElementById('rpClassic').onclick = function () { lsSet('rp_ui', 'classic'); lsSet('rp_boot_fail', '0'); location.href = 'classic.html'; };
    document.getElementById('rpRollback').onclick = rollbackData;
    document.getElementById('rpExport').onclick = exportRaw;
  };
})();
