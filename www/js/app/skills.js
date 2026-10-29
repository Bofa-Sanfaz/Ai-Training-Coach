'use strict';
// --------------------------------------------------------
// COACH SKILLS (SKILL.md format: --- name / description / agents --- + markdown body)
// Built-in skills ship in www/skills/. More can be imported from any GitHub URL.
// Each AI role ("agent") only receives the skills assigned to it.
// --------------------------------------------------------
const AI_AGENTS = {
  aether: 'Aether (season coach)',
  ride: 'Ride coach',
  compare: 'Compare',
  report: 'Reports',
  trends: 'Trends audit',
  planner: 'Week planner'
};
const MAX_SKILL_CHARS = 12000;
let SKILLS = [];

function parseSkillMd(md, fallbackName) {
  const text = String(md || '').replace(/\r/g, '');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = (m ? text.slice(m[0].length) : text).trim();
  const agents = (meta.agents || '').split(/[,\s]+/).map(a => a.trim().toLowerCase()).filter(a => AI_AGENTS[a]);
  return {
    name: (meta.name || fallbackName || 'skill').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60),
    description: (meta.description || '').slice(0, 300),
    agents,
    body: body.slice(0, MAX_SKILL_CHARS)
  };
}

async function loadSkills() {
  const builtins = [];
  try {
    const idx = await (await fetch('skills/index.json')).json();
    for (const id of idx.skills || []) {
      try {
        const s = parseSkillMd(await (await fetch(`skills/${id}.md`)).text(), id);
        builtins.push(Object.assign(s, { id, builtin: true, source: 'built-in' }));
      } catch (e) {
        console.warn('Skill failed to load', id, e);
      }
    }
  } catch (e) {
    console.warn('Skill index failed to load', e);
  }
  const custom = (await getJsonConfig('custom_skills', [])).filter(s => s && s.id && s.body);
  const disabled = new Set(await getJsonConfig('skills_disabled', []));
  SKILLS = builtins.concat(custom.map(s => Object.assign({}, s, { builtin: false })));
  SKILLS.forEach(s => { s.enabled = !disabled.has(s.id); });
  return SKILLS;
}

// The block injected into a prompt for one agent
function skillsFor(agent) {
  const list = SKILLS.filter(s => s.enabled && s.agents.includes(agent));
  if (!list.length) return '';
  return `COACHING SKILLS (follow these methods):\n${list.map(s => `### ${s.name}\n${s.body}`).join('\n\n')}`;
}

// github.com/…/blob/branch/path → raw.githubusercontent.com/…/branch/path; folders → …/SKILL.md
function toRawGithubUrl(url) {
  let u = String(url || '').trim();
  const blob = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/);
  if (blob) {
    u = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  }
  if (/raw\.githubusercontent\.com/.test(u) && !/\.(md|markdown|txt)$/i.test(u)) u = `${u.replace(/\/$/, '')}/SKILL.md`;
  return u;
}

async function importSkillFromUrl() {
  const input = $('#skill_url');
  const raw = toRawGithubUrl(input.value);
  if (!/^https:\/\//.test(raw)) { toast('Paste a GitHub link to a SKILL.md file.', 'warn'); return; }
  const btn = $('#btnImportSkill');
  setBusy(btn, true, 'Importing…');
  try {
    const res = await fetch(raw);
    if (!res.ok) throw new Error(`HTTP ${res.status} — check the link`);
    const text = await res.text();
    if (text.length < 40) throw new Error('That file is empty.');
    const s = parseSkillMd(text, raw.split('/').slice(-2, -1)[0]);
    if (!s.agents.length) s.agents = ['aether', 'ride', 'report', 'planner'];
    const custom = await getJsonConfig('custom_skills', []);
    const id = `custom-${s.name}`;
    const entry = { id, name: s.name, description: s.description || 'Imported skill', agents: s.agents, body: s.body, source: raw, imported_at: new Date().toISOString() };
    const i = custom.findIndex(c => c.id === id);
    if (i >= 0) custom[i] = entry; else custom.push(entry);
    await setJsonConfig('custom_skills', custom);
    input.value = '';
    await loadSkills();
    renderSkills();
    toast(`Skill "${s.name}" imported${text.length > MAX_SKILL_CHARS ? ' (trimmed to 12k characters)' : ''}`, 'success');
    haptic('success');
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error', 5000);
  } finally {
    setBusy(btn, false);
  }
}

async function toggleSkill(id, on) {
  const disabled = new Set(await getJsonConfig('skills_disabled', []));
  if (on) disabled.delete(id); else disabled.add(id);
  await setJsonConfig('skills_disabled', [...disabled]);
  const s = SKILLS.find(x => x.id === id);
  if (s) s.enabled = on;
  haptic('light');
}

async function toggleSkillAgent(id, agent) {
  const custom = await getJsonConfig('custom_skills', []);
  const c = custom.find(x => x.id === id);
  if (!c) return;
  c.agents = c.agents.includes(agent) ? c.agents.filter(a => a !== agent) : c.agents.concat(agent);
  await setJsonConfig('custom_skills', custom);
  await loadSkills();
  renderSkills();
}

async function removeSkill(id) {
  if (!(await uiConfirm('Remove skill?', 'The coaches will stop using it.', { okText: 'Remove', danger: true }))) return;
  await setJsonConfig('custom_skills', (await getJsonConfig('custom_skills', [])).filter(c => c.id !== id));
  await loadSkills();
  renderSkills();
}

function renderSkills() {
  const host = $('#skillList');
  if (!host) return;
  host.innerHTML = SKILLS.map(s => `
    <div class="skill-row">
      <div class="row between">
        <span class="grow"><b>${escapeHtml(s.name)}</b> ${s.builtin ? '' : '<span class="badge badge-new">Imported</span>'}<br><span class="tiny muted">${escapeHtml(s.description)}</span></span>
        <label class="switch-row" style="padding:0"><input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="toggleSkill('${escapeHtml(s.id)}', this.checked)" aria-label="Use ${escapeHtml(s.name)}" /></label>
      </div>
      <div class="chip-rack wrap mt-8">${Object.entries(AI_AGENTS).map(([k, label]) => {
        const on = s.agents.includes(k);
        return s.builtin
          ? (on ? `<span class="agent-chip on">${escapeHtml(label)}</span>` : '')
          : `<button class="agent-chip ${on ? 'on' : ''}" onclick="toggleSkillAgent('${escapeHtml(s.id)}','${k}')">${escapeHtml(label)}</button>`;
      }).join('')}</div>
      ${s.builtin ? '' : `<div class="row between mt-8"><span class="tiny muted" style="word-break:break-all">${escapeHtml(s.source || '')}</span><button class="x-btn" onclick="removeSkill('${escapeHtml(s.id)}')" aria-label="Remove">${icon('x')}</button></div>`}
    </div>`).join('') || '<div class="small muted">No skills loaded.</div>';
}
