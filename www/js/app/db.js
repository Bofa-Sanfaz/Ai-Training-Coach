'use strict';
// --------------------------------------------------------
// DATABASE
// IMPORTANT: the schema versions below are identical to v2.
// Do NOT add a db.version(4): classic.html (the rollback UI)
// must be able to open the same database. New fields are
// stored as non-indexed properties, which needs no migration.
// --------------------------------------------------------
const db = new Dexie('RidePartnerDB');
db.version(1).stores({
  workouts: '++id, &strava_id, ride_number, exercise_code, date, distance_km, avg_power_w, max_power_w, norm_power_w, avg_hr, max_hr, avg_speed_kmh, max_speed_kmh, elevation_gain_m, kilojoules, calories, duration_str, moving_sec, debrief_stale',
  streams: 'strava_id, stream_data',
  threads: '++id, ride_number, role, message, image_b64, created_at',
  master_chat: '++id, role, message, image_b64, created_at',
  graph_threads: '++id, metric_key, role, message, created_at',
  reports: 'id, ref_code, created_at, timeframe, analysis_text',
  config: 'key, val'
});
db.version(2).stores({
  workouts: '++id, &strava_id, ride_number, exercise_code, date, distance_km, avg_power_w, max_power_w, norm_power_w, avg_hr, max_hr, avg_speed_kmh, max_speed_kmh, elevation_gain_m, kilojoules, calories, duration_str, moving_sec, debrief_stale, intent_type',
  threads: '++id, ride_number, role, [ride_number+role], created_at',
  master_chat: '++id, role, created_at',
  graph_threads: '++id, metric_key, role, created_at',
  reports: 'id, ref_code, created_at, timeframe, analysis_text, ride_count, date_range'
}).upgrade(() => {});
db.version(3).stores({
  threads: '++id, strava_id, ride_number, role, [strava_id+role], created_at'
}).upgrade(async tx => {
  const workouts = await tx.table('workouts').toArray();
  const rToS = new Map(workouts.map(w => [w.ride_number, w.strava_id]));
  await tx.table('threads').toCollection().modify(t => {
    if (!t.strava_id && t.ride_number && rToS.has(t.ride_number)) t.strava_id = rToS.get(t.ride_number);
  });
});

// Restore points live in their own database so a broken main DB can still be rolled back.
const restoreDb = new Dexie('RidePartnerRestorePoints');
restoreDb.version(1).stores({ snapshots: '++id, created_at, reason, kind' });

const SENSITIVE_KEYS = ['gemini_api_key', 'strava_client_secret', 'strava_refresh_token', 'strava_access_token', 'strava_token_expires'];
const DATA_TABLES = ['workouts', 'threads', 'master_chat', 'graph_threads', 'reports', 'config'];
const MAX_AUTO_RESTORE_POINTS = 6;
const MAX_MANUAL_RESTORE_POINTS = 6;

async function getConfig(key) {
  const r = await db.config.get(key);
  return r && r.val !== null && r.val !== undefined ? r.val : '';
}

async function setConfig(key, val) {
  await db.config.put({ key, val });
}

async function getJsonConfig(key, fallback) {
  const raw = await getConfig(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function setJsonConfig(key, obj) {
  await setConfig(key, JSON.stringify(obj));
}

// Thread helpers (keyed by strava_id)
function rideThreads(stravaId) {
  return db.threads.where('strava_id').equals(Number(stravaId));
}

async function hasCoachDebrief(stravaId) {
  return !!(await db.threads.where('[strava_id+role]').equals([Number(stravaId), 'coach']).first());
}

async function firstAthleteNote(stravaId) {
  return db.threads.where('[strava_id+role]').equals([Number(stravaId), 'athlete']).first();
}

// --------------------------------------------------------
// FULL DUMP / RESTORE (used by JSON backups and restore points)
// --------------------------------------------------------
// AI provider settings hold API keys inside one JSON value — strip or merge them explicitly
function stripProviderKeys(row) {
  if (!row || row.key !== 'ai_providers') return row;
  try {
    const s = JSON.parse(row.val);
    (s.providers || []).forEach(p => { p.apiKey = ''; });
    return { key: row.key, val: JSON.stringify(s) };
  } catch (e) {
    return null;
  }
}

function mergeProviderKeys(restoredRow, currentRow) {
  try {
    const cur = JSON.parse(currentRow.val);
    if (!restoredRow) return currentRow;
    const res = JSON.parse(restoredRow.val);
    for (const p of res.providers || []) {
      const match = (cur.providers || []).find(c => c.id === p.id);
      if (match && !p.apiKey) p.apiKey = match.apiKey;
    }
    return { key: 'ai_providers', val: JSON.stringify(res) };
  } catch (e) {
    return currentRow;
  }
}

async function buildDump({ includeSecrets = false } = {}) {
  let config = await db.config.toArray();
  if (!includeSecrets) config = config.filter(c => !SENSITIVE_KEYS.includes(c.key)).map(stripProviderKeys).filter(Boolean);
  return {
    app: 'RidePartner',
    version: 3,
    app_version: APP_VERSION,
    exported_at: new Date().toISOString(),
    workouts: await db.workouts.toArray(),
    threads: await db.threads.toArray(),
    master_chat: await db.master_chat.toArray(),
    graph_threads: await db.graph_threads.toArray(),
    reports: await db.reports.toArray(),
    config
  };
}

async function restoreDump(data, { preserveSecrets = true } = {}) {
  if (!data || !Array.isArray(data.workouts)) throw new Error('Invalid backup format: workouts table missing.');
  const current = await db.config.toArray();
  const keep = preserveSecrets ? current.filter(c => SENSITIVE_KEYS.includes(c.key) || c.key === 'strava_client_id') : [];
  const curProviders = current.find(c => c.key === 'ai_providers');
  if (preserveSecrets && curProviders) {
    const restored = Array.isArray(data.config) ? data.config.find(c => c.key === 'ai_providers') : null;
    keep.push(mergeProviderKeys(restored, curProviders));
  }

  await db.transaction('rw', db.workouts, db.threads, db.master_chat, db.graph_threads, db.reports, db.config, async () => {
    for (const t of DATA_TABLES) await db.table(t).clear();
    if (data.workouts.length) await db.workouts.bulkPut(data.workouts);
    if (Array.isArray(data.threads) && data.threads.length) await db.threads.bulkPut(data.threads);
    if (Array.isArray(data.master_chat) && data.master_chat.length) await db.master_chat.bulkPut(data.master_chat);
    if (Array.isArray(data.graph_threads) && data.graph_threads.length) await db.graph_threads.bulkPut(data.graph_threads);
    if (Array.isArray(data.reports) && data.reports.length) await db.reports.bulkPut(data.reports);
    if (Array.isArray(data.config) && data.config.length) await db.config.bulkPut(data.config);
    if (keep.length) await db.config.bulkPut(keep);
  });
  // Rescue / full backups may also carry telemetry streams (saves re-downloading from Strava)
  if (Array.isArray(data.streams) && data.streams.length) {
    for (let i = 0; i < data.streams.length; i += 25) await db.streams.bulkPut(data.streams.slice(i, i + 25).filter(s => s && s.strava_id));
  }
}

// --------------------------------------------------------
// RESTORE POINTS (ROLLBACK)
// Streams are excluded (large, unchanged by the app, re-downloadable).
// --------------------------------------------------------
async function createRestorePoint(reason, kind = 'auto') {
  try {
    const dump = await buildDump({ includeSecrets: false });
    const json = JSON.stringify(dump);
    await restoreDb.snapshots.add({
      created_at: new Date().toISOString(),
      reason,
      kind,
      app_version: APP_VERSION,
      ride_count: dump.workouts.length,
      size: json.length,
      data: json
    });
    await pruneRestorePoints();
    return true;
  } catch (e) {
    console.warn('Restore point failed:', e);
    return false;
  }
}

async function pruneRestorePoints() {
  for (const [kind, max] of [['auto', MAX_AUTO_RESTORE_POINTS], ['manual', MAX_MANUAL_RESTORE_POINTS]]) {
    const list = (await restoreDb.snapshots.toArray()).filter(s => (s.kind || 'auto') === kind).sort((a, b) => a.id - b.id);
    const extra = list.length - max;
    if (extra > 0) await restoreDb.snapshots.bulkDelete(list.slice(0, extra).map(s => s.id));
  }
}

async function listRestorePoints() {
  const all = await restoreDb.snapshots.toArray();
  return all.map(({ data, ...meta }) => meta).sort((a, b) => b.id - a.id);
}

async function rollbackToRestorePoint(id) {
  const snap = await restoreDb.snapshots.get(id);
  if (!snap) throw new Error('Restore point not found.');
  await createRestorePoint(`Before rolling back to #${id}`, 'auto');
  await restoreDump(JSON.parse(snap.data), { preserveSecrets: true });
}

async function deleteRestorePoint(id) {
  await restoreDb.snapshots.delete(id);
}

// --------------------------------------------------------
// FILE OUTPUT: share sheet on Android, download in browser
// --------------------------------------------------------
async function saveOrShareFile(fileName, data, { mime = 'application/octet-stream', base64 = false, title = fileName } = {}) {
  const Filesystem = capPlugin('Filesystem');
  const Share = capPlugin('Share');

  if (isNative() && Filesystem) {
    try {
      const res = await Filesystem.writeFile(Object.assign(
        { path: fileName, data, directory: 'CACHE' },
        base64 ? {} : { encoding: 'utf8' }
      ));
      if (Share && res && res.uri) {
        try {
          await Share.share({ title, files: [res.uri], dialogTitle: `Save or send ${fileName}` });
          return { ok: true, where: 'share sheet' };
        } catch (shareErr) {
          if (/cancel/i.test(String(shareErr && shareErr.message))) return { ok: false, cancelled: true };
        }
      }
    } catch (e) {
      console.warn('Cache write failed', e);
    }
    try {
      await Filesystem.writeFile(Object.assign(
        { path: `RidePartner/${fileName}`, data, directory: 'DOCUMENTS', recursive: true },
        base64 ? {} : { encoding: 'utf8' }
      ));
      return { ok: true, where: 'Documents/RidePartner' };
    } catch (e) {
      console.warn('Documents write failed', e);
    }
  }

  const blob = base64
    ? new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: mime })
    : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { ok: true, where: 'Downloads' };
}
