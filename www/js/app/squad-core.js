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
    // battles: id → { metric, sport, from, to, mode, target, finish, title, stake, by, accepted[], declined[], status }
    // photos: pid → { pid, date, pose, note, author, id (event id: delete it to unshare) } — shared by choice only
    const st = { messages: [], activities: new Map(), comments: {}, reactions: {}, system: [], daily: {}, deleted: new Set(), battles: new Map(), photos: new Map() };
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
      } else if (e.kind === 'photo' && b.pid) {
        st.photos.set(b.pid, Object.assign({}, b, { author: e.author, id: e.id, seq: e.seq, created_at: e.created_at }));
      } else if (e.kind === 'battle' && b.bid) {
        // A challenge between members: the creator proposes, the others accept or decline;
        // only the creator can call it off (the server only checks the shape, this decides who may)
        const cur = st.battles.get(b.bid);
        if (b.op === 'create' && !cur) {
          const { op, ...rest } = b;
          st.battles.set(b.bid, Object.assign(rest, { id: b.bid, by: e.author, seq: e.seq, created_at: e.created_at, accepted: [], declined: [], status: 'open' }));
        } else if (cur && cur.status === 'open') {
          if (b.op === 'accept' && e.author !== cur.by && !cur.accepted.includes(e.author)) { cur.accepted.push(e.author); cur.declined = cur.declined.filter(x => x !== e.author); }
          else if (b.op === 'decline' && e.author !== cur.by && !cur.accepted.includes(e.author) && !cur.declined.includes(e.author)) cur.declined.push(e.author);
          else if (b.op === 'cancel' && e.author === cur.by) cur.status = 'cancelled';
        }
      }
    }
    return st;
  }

  /**
   * Battle progress. Metrics: minutes · days (active days) · sessions · km (not swims) · swim_m.
   * mode 'own': each person's target is his own usual for the battle's length (minutes: usual
   * weekly minutes; days and sessions: his target days) — fair between different people;
   * mode 'same': one target for everyone. finish 'first': the first to 100 % wins (by workout
   * date and time); 'end': the highest % on the last day. score: compute() (own usuals).
   */
  const BATTLE_METRICS = ['minutes', 'days', 'sessions', 'km', 'swim_m'];
  function battle(b, members, activities, today, score) {
    const fromN = dayNum(b.from), toN = dayNum(b.to), todayN = dayNum(today);
    const len = Math.max(1, toN - fromN + 1);
    const ids = [b.by].concat(b.accepted || []).filter((id, i, a) => a.indexOf(id) === i && members.some(m => m.id === id));
    const people = ids.map(id => {
      const own = score && score.members[id];
      let target = num(b.target);
      if (b.mode === 'own') {
        if (b.metric === 'minutes') target = Math.max(20, Math.round(num(own && own.weekly_min) * len / 7) || 60);
        else target = Math.max(1, Math.round(num(own && own.target) * len / 7) || Math.round(3 * len / 7) || 1);
      }
      target = Math.max(b.metric === 'km' ? 0.5 : 1, target);
      const acts = activities.filter(a => a.author === id && a.date && dayNum(a.date) >= fromN && dayNum(a.date) <= toN
        && (b.metric === 'swim_m' ? a.sport === 'swim' : b.metric === 'km' ? a.sport !== 'swim' : true)
        && (!b.sport || b.sport === 'any' || a.sport === b.sport))
        .sort((x, y) => `${x.date} ${x.start || '23:59'}`.localeCompare(`${y.date} ${y.start || '23:59'}`) || num(x.seq) - num(y.seq));
      let value = 0, reachedAt = null;
      const days = new Set();
      for (const a of acts) {
        if (b.metric === 'days') days.add(a.date);
        value = b.metric === 'minutes' ? value + num(a.dur_s) / 60 : b.metric === 'days' ? days.size : b.metric === 'sessions' ? value + 1
          : b.metric === 'km' ? value + num(a.dist_m) / 1000 : value + num(a.dist_m);
        if (!reachedAt && value >= target) reachedAt = `${a.date} ${a.start || '23:59'}`;
      }
      return { id, value: round1(value), target: round1(target), pct: Math.round(value / target * 100), reachedAt };
    });
    const live = ids.length > 1;
    const first = people.filter(p => p.reachedAt).sort((x, y) => x.reachedAt.localeCompare(y.reachedAt));
    let done = false, winners = [];
    if (live && b.finish === 'first' && first.length) { done = true; winners = first.filter(p => p.reachedAt === first[0].reachedAt).map(p => p.id); }
    else if (live && todayN > toN) {
      done = true;
      const top = Math.max(...people.map(p => p.pct));
      winners = top > 0 ? people.filter(p => p.pct === top).map(p => p.id) : [];
    }
    return { people, live, done, winners, days_left: Math.max(0, toN - todayN + 1), started: todayN >= fromN };
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
   * notBefore: the running arc's first day — a month an arc starts in only counts from that day.
   */
  function month(members, activities, daily, ym, score, notBefore) {
    const last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
    const first = `${ym}-01`, end = `${ym}-${String(last).padStart(2, '0')}`;
    const from = notBefore && notBefore > first && notBefore <= end ? notBefore : first;
    return Object.assign(period(members, activities, daily, from, end, score), { month: ym });
  }

  // Any date range (a month, an arc…) in numbers per member
  function period(members, activities, daily, from, to, score) {
    const out = { from, to, days: dayNum(to) - dayNum(from) + 1, members: {} };
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

  /**
   * AI context digest, built on the phone (which already has everything folded and scored)
   * and uploaded after each sync, so the server's AI runs never re-read the whole history
   * (free plan: 10 ms CPU per request). seq = newest event the phone had.
   */
  const DIGEST_DAYS = 62;      // sessions the AI can see (month report, quiet days)
  const DIGEST_FULL_DAYS = 14; // with every detail (lengths, verdict, note); older ones compact
  const COMPACT = ['ref', 'author', 'seq', 'key', 'date', 'start', 'sport', 'title', 'type', 'dur_s', 'dist_m', 'pace_km', 'pace100', 'speed_kmh', 'swolf', 'avg_hr', 'load', 'steps', 'pb'];
  function digest(seq, today, folded, score) {
    const from = dateOf(dayNum(today) - DIGEST_DAYS);
    const full = dateOf(dayNum(today) - DIGEST_FULL_DAYS);
    const recent = [], last = {};
    for (const a of folded.activities.values()) {
      if (a.pending) continue;
      if (!last[a.author] || a.date > last[a.author]) last[a.author] = a.date;
      if (a.date < from) continue;
      if (a.date >= full) recent.push(a);
      else { const c = {}; for (const k of COMPACT) if (a[k] !== undefined && a[k] !== null) c[k] = a[k]; recent.push(c); }
    }
    const daily = {};
    for (const [m, days] of Object.entries(folded.daily || {})) {
      for (const [d, v] of Object.entries(days)) if (d >= from) (daily[m] = daily[m] || {})[d] = v;
    }
    return { v: 1, seq, today, score, recent, daily, last_dates: last };
  }

  return { fold, actRef, compute, month, period, digest, battle, BATTLE_METRICS, METRIC, WEIGHTS: W };
})();
if (typeof globalThis !== 'undefined') globalThis.SquadCore = SquadCore;
