'use strict';
// --------------------------------------------------------
// ATHLETE HISTORY: dated weight log and training phases
// (stored in config exactly like v2, so classic.html shares them)
// --------------------------------------------------------
async function getWeightHistory() {
  const arr = await getJsonConfig('athlete_weight_history', []);
  return Array.isArray(arr) ? arr.filter(e => e && e.date && num(e.weight) > 0) : [];
}

async function saveWeightHistory(arr) {
  arr.sort((a, b) => parseSafeDate(a.date) - parseSafeDate(b.date));
  await setJsonConfig('athlete_weight_history', arr);
}

// Weight in effect on a date; rides before the first entry use the first entry
async function getAthleteWeightForDate(dateStr, historyCache) {
  const history = historyCache || await getWeightHistory();
  if (!history.length) return null;
  const target = dateStr ? parseSafeDate(dateStr).getTime() : Date.now();
  let matched = null;
  for (const e of history) {
    if (parseSafeDate(e.date).getTime() <= target) matched = e.weight;
    else break;
  }
  return num(matched !== null ? matched : history[0].weight) || null;
}

async function getLatestWeight() {
  const h = await getWeightHistory();
  return h.length ? num(h[h.length - 1].weight) || null : null;
}

async function getWeightPromptSummary() {
  const h = await getWeightHistory();
  if (!h.length) return 'Not Logged / Unspecified';
  if (h.length === 1) return `${h[0].weight} kg (Baseline Logged on ${h[0].date})`;
  const first = h[0];
  const last = h[h.length - 1];
  return `${first.weight} kg (${first.date}) -> ${last.weight} kg (${last.date}), change ${signed(num(last.weight) - num(first.weight), 1)} kg`;
}

async function getTrainingGoalHistory() {
  const arr = await getJsonConfig('athlete_goal_history', []);
  return Array.isArray(arr) ? arr.filter(e => e && e.effective_date && e.goal) : [];
}

async function saveTrainingGoalHistory(arr) {
  arr.sort((a, b) => parseSafeDate(a.effective_date) - parseSafeDate(b.effective_date));
  await setJsonConfig('athlete_goal_history', arr);
}

async function getActiveTrainingGoalForDate(dateStr) {
  const history = await getTrainingGoalHistory();
  if (!history.length) return 'Not Set / Unspecified';
  const target = dateStr ? parseSafeDate(dateStr).getTime() : Date.now();
  let matched = null;
  for (const e of history) {
    if (parseSafeDate(e.effective_date).getTime() <= target) matched = e.goal;
    else break;
  }
  return matched || 'Not Set / Unspecified';
}
