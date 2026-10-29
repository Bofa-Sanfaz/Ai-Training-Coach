'use strict';
// --------------------------------------------------------
// SQUAD CORE — shared by the app and the Squad server (same file, no copies)
// 1. fold(events): turns the challenge's event log into chat, feed, comments, reactions.
//    Refs: a message/comment is addressed by its event id; an activity by
//    actRef(author, key) because re-shared versions of one workout get new event ids.
// 2. compute(...): the scoreboard. Everyone is scored against HIMSELF: his own target
//    days, his own usual minutes, his own usual pace — raw numbers are never compared.
//      weekly score = consistency 40 + volume 30 + improvement 30 + bonuses
//    Activity fields used: date (YYYY-MM-DD, local), dur_s, sport, pace_km (s/km,
//    run/walk), pace100 (s/100 m, swim), speed_kmh (ride), pb (array of labels).
// --------------------------------------------------------
const SquadCore = (() => {
  const actRef = (author, key) => `act:${author}:${key}`;

  function fold(events) {
    // daily: { memberId: { 'YYYY-MM-DD': { weight_kg, rhr, sleep_min, steps, hrv } } } — shared by choice only
    const st = { messages: [], activities: new Map(), comments: {}, reactions: {}, system: [], daily: {}, deleted: new Set() };
    const ordered = events.slice().sort((a, b) => a.seq - b.seq);
    for (const e of ordered) if (e.kind === 'delete' && e.ref) st.deleted.add(e.ref);
    for (const e of ordered) {
      if (st.deleted.has(e.id)) continue;
      const b = e.body || {};
      if (e.kind === 'msg') st.messages.push(e);
      else if (e.kind === 'system') st.system.push(e);
      else if (e.kind === 'activity' && b.key) {
        const ref = actRef(e.author, b.key);
        if (!st.deleted.has(ref)) st.activities.set(ref, Object.assign({}, b, { ref, author: e.author, seq: e.seq, id: e.id, created_at: e.created_at }));
      } else if (e.kind === 'daily' && b.date) {
        const m = st.daily[e.author] = st.daily[e.author] || {};
        if (b.clear) delete m[b.date]; else m[b.date] = b;
      } else if (e.kind === 'comment' && e.ref) (st.comments[e.ref] = st.comments[e.ref] || []).push(e);
      else if (e.kind === 'reaction' && e.ref && b.emoji) {
        const r = st.reactions[e.ref] = st.reactions[e.ref] || {};
        const who = r[b.emoji] = r[b.emoji] || new Set();
        if (b.on === false) who.delete(e.author); else who.add(e.author);
        if (!who.size) delete r[b.emoji];
      }
    }
    return st;
  }

  const DAY = 86400000;
  const W = { consistency: 40, volume: 30, improvement: 30 };
  // Which number shows progress per sport, and whether lower is better
  const METRIC = {
    swim: { field: 'pace100', lower: true, label: 'pace /100 m' },
    walk: { field: 'pace_km', lower: true, label: 'pace /km' },
    run: { field: 'pace_km', lower: true, label: 'pace /km' },
    ride: { field: 'speed_kmh', lower: false, label: 'speed' }
  };
  const IMPROVE_FULL = 0.05; // 5 % better than your own usual = full improvement points

  const dayNum = d => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
  const dateOf = n => new Date(n * DAY).toISOString().slice(0, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round1 = v => Math.round(v * 10) / 10;
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);

  // Duration-weighted average of a metric over activities (ignores missing values)
  function avgMetric(acts, sport) {
    const m = METRIC[sport];
    if (!m) return null;
    let sum = 0, w = 0;
    for (const a of acts) {
      if (a.sport !== sport || !(num(a[m.field]) > 0)) continue;
      const wt = Math.max(60, num(a.dur_s));
      sum += a[m.field] * wt;
      w += wt;
    }
    return w ? sum / w : null;
  }

  // Baseline for a member: what he sent from his own history, otherwise his first challenge week
  function baselineOf(member, acts, startN) {
    const b = Object.assign({}, member.baseline || {});
    const first = acts.filter(a => dayNum(a.date) < startN + 7);
    if (!(b.weekly_min > 0) && first.length) b.weekly_min = first.reduce((s, a) => s + num(a.dur_s), 0) / 60;
    b.metrics = Object.assign({}, b.metrics || {});
    for (const sp of Object.keys(METRIC)) if (!(b.metrics[sp] > 0)) {
      const v = avgMetric(first, sp);
      if (v) { b.metrics[sp] = v; b.fromChallenge = true; }
    }
    return b;
  }

  // Improvement this week: % better than baseline per sport, weighted by minutes in that sport
  function improvement(weekActs, base) {
    let score = 0, w = 0;
    const parts = [];
    for (const sp of Object.keys(METRIC)) {
      const ref = base.metrics && base.metrics[sp];
      const cur = avgMetric(weekActs, sp);
      if (!(ref > 0) || !cur) continue;
      const pct = METRIC[sp].lower ? (ref - cur) / ref : (cur - ref) / ref;
      const mins = weekActs.filter(a => a.sport === sp).reduce((s, a) => s + num(a.dur_s), 0) / 60;
      score += clamp(pct / IMPROVE_FULL, -1, 1) * mins;
      w += mins;
      parts.push({ sport: sp, pct: round1(pct * 100), label: METRIC[sp].label });
    }
    // Neutral (half points) when nothing comparable was done
    return { ratio: w ? score / w : 0, parts };
  }

  /**
   * challenge: { starts, ends, rules: { days_per_week } }
   * members: [{ id, name, baseline }]
   * activities: [{ author, ...summary }]  (already folded: latest version per key, deleted removed)
   * today: 'YYYY-MM-DD' (challenge-local)
   */
  function compute(challenge, members, activities, today) {
    const startN = dayNum(challenge.starts);
    const lastN = Math.min(dayNum(today), challenge.ends ? dayNum(challenge.ends) : Infinity);
    const weeks = Math.max(1, Math.floor((lastN - startN) / 7) + 1);
    const rules = challenge.rules || {};
    const out = { weeks, today, members: {}, duels: [] };

    for (const m of members) {
      const acts = activities.filter(a => a.author === m.id && a.date && dayNum(a.date) >= startN && dayNum(a.date) <= lastN);
      const base = baselineOf(m, acts, startN);
      const target = clamp(num(base.target_days) || num(rules.days_per_week) || 4, 1, 7);
      const activeDays = new Set(acts.map(a => dayNum(a.date)));
      // Streaks over the whole challenge
      let run = 0, best = 0;
      const streakAt = {};
      for (let n = startN; n <= lastN; n++) {
        run = activeDays.has(n) ? run + 1 : 0;
        streakAt[n] = run;
        best = Math.max(best, run);
      }
      const current = streakAt[lastN] || (activeDays.has(lastN) ? 0 : streakAt[lastN - 1] || 0);
      const rows = [];
      for (let w = 0; w < weeks; w++) {
        const from = startN + w * 7, to = Math.min(from + 6, lastN);
        const wa = acts.filter(a => { const n = dayNum(a.date); return n >= from && n <= to; });
        const days = new Set(wa.map(a => dayNum(a.date))).size;
        const minutes = wa.reduce((s, a) => s + num(a.dur_s), 0) / 60;
        const cons = clamp(days / target, 0, 1.25);
        const volRatio = base.weekly_min > 0 ? minutes / base.weekly_min : (minutes > 0 ? 1 : 0);
        const imp = improvement(wa, base);
        const pbs = wa.reduce((s, a) => s + (Array.isArray(a.pb) ? a.pb.length : 0), 0);
        let streakDays = 0;
        for (let n = from; n <= to; n++) if (streakAt[n] >= 3) streakDays++;
        const pts = {
          consistency: W.consistency * Math.min(cons, 1),
          volume: W.volume * clamp(volRatio, 0, 1.5) / 1.5,
          improvement: wa.length ? W.improvement * (0.5 + imp.ratio / 2) : 0,
          bonus: Math.min(15, pbs * 5) + Math.min(7, streakDays) + (cons > 1 ? 3 : 0)
        };
        const total = pts.consistency + pts.volume + pts.improvement + pts.bonus;
        rows.push({
          week: w + 1, from: dateOf(from), to: dateOf(to), complete: to - from === 6 && to < dayNum(today),
          days, target, minutes: Math.round(minutes), volume_pct: Math.round(volRatio * 100),
          improvement: imp.parts, pbs, streak_days: streakDays,
          points: Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, round1(v)])), total: round1(total)
        });
      }
      out.members[m.id] = {
        name: m.name, target, weekly_min: Math.round(num(base.weekly_min)), baseline_from_challenge: !!base.fromChallenge,
        weeks: rows, total: round1(rows.reduce((s, r) => s + r.total, 0)),
        this_week: rows[rows.length - 1], streak: current, best_streak: best,
        activities: acts.length, pbs: rows.reduce((s, r) => s + r.pbs, 0)
      };
    }
    // Weekly duel: higher relative score wins the week (ties stay ties)
    const ids = members.map(m => m.id);
    for (let w = 0; w < weeks; w++) {
      const scores = ids.map(id => ({ id, total: out.members[id].weeks[w].total }));
      const top = Math.max(...scores.map(s => s.total));
      const winners = scores.filter(s => s.total === top && top > 0).map(s => s.id);
      out.duels.push({ week: w + 1, from: out.members[ids[0]] ? out.members[ids[0]].weeks[w].from : '', winners, complete: ids.length ? out.members[ids[0]].weeks[w].complete : false });
    }
    out.wins = Object.fromEntries(ids.map(id => [id, out.duels.filter(d => d.complete && d.winners.length === 1 && d.winners[0] === id).length]));
    return out;
  }

  /**
   * Month in numbers per member (the squad's monthly report — app and AI use the same numbers).
   * month: 'YYYY-MM'. daily: fold().daily. score: compute() result (for weekly points in the month).
   */
  function month(members, activities, daily, ym, score) {
    const from = `${ym}-01`;
    const last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
    const to = `${ym}-${String(last).padStart(2, '0')}`;
    const out = { month: ym, from, to, days: last, members: {} };
    for (const m of members) {
      const acts = activities.filter(a => a.author === m.id && a.date >= from && a.date <= to);
      const by = {};
      for (const a of acts) {
        const s = by[a.sport] = by[a.sport] || { n: 0, minutes: 0, dist_m: 0 };
        s.n++; s.minutes += num(a.dur_s) / 60; s.dist_m += num(a.dist_m);
      }
      for (const s of Object.values(by)) { s.minutes = Math.round(s.minutes); s.dist_m = Math.round(s.dist_m); }
      const days = [...new Set(acts.map(a => a.date))].sort();
      let run = 0, bestRun = 0, prev = null;
      for (const d of days) { run = prev !== null && dayNum(d) - prev === 1 ? run + 1 : 1; bestRun = Math.max(bestRun, run); prev = dayNum(d); }
      const dd = Object.entries((daily && daily[m.id]) || {}).filter(([d]) => d >= from && d <= to).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
      const series = f => dd.filter(v => num(v[f]) > 0).map(v => v[f]);
      const avg = f => { const s = series(f); return s.length ? round1(s.reduce((x, y) => x + y, 0) / s.length) : null; };
      const w = series('weight_kg');
      const longest = acts.slice().sort((a, b) => num(b.dur_s) - num(a.dur_s))[0] || null;
      const weekPts = score && score.members[m.id] ? score.members[m.id].weeks.filter(x => x.to >= from && x.from <= to) : [];
      out.members[m.id] = {
        name: m.name, sessions: acts.length, active_days: days.length, minutes: Math.round(acts.reduce((s, a) => s + num(a.dur_s), 0) / 60),
        dist_m: Math.round(acts.reduce((s, a) => s + num(a.dist_m), 0)), by_sport: by,
        pbs: acts.flatMap(a => (Array.isArray(a.pb) ? a.pb.map(p => `${p} (${a.date})`) : [])), best_streak: bestRun,
        load: Math.round(acts.reduce((s, a) => s + num(a.load), 0)),
        longest: longest ? { title: longest.title || longest.sport, date: longest.date, dur_s: longest.dur_s, dist_m: longest.dist_m || 0 } : null,
        weight_start: w.length ? w[0] : null, weight_end: w.length ? w[w.length - 1] : null,
        avg_sleep_min: avg('sleep_min'), avg_rhr: avg('rhr'), avg_steps: avg('steps') !== null ? Math.round(avg('steps')) : null,
        week_points: weekPts.map(x => ({ week: x.week, total: x.total })),
        avg_week_points: weekPts.length ? round1(weekPts.reduce((s, x) => s + x.total, 0) / weekPts.length) : null
      };
    }
    return out;
  }

  return { fold, actRef, compute, month, METRIC, WEIGHTS: W };
})();
if (typeof globalThis !== 'undefined') globalThis.SquadCore = SquadCore;
