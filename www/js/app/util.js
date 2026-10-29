'use strict';
// --------------------------------------------------------
// GENERAL UTILITIES: numbers, dates, formatting, markdown
// --------------------------------------------------------
const APP_VERSION = '3.3.1';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function hasVal(v) {
  return v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v));
}

// Null-safe sum (fixes NaN totals when a ride lacks a field)
function sumBy(arr, fn) {
  return arr.reduce((a, b) => a + num(fn(b)), 0);
}

function round(v, d = 0) {
  const p = 10 ** d;
  return Math.round(num(v) * p) / p;
}

function fmtNum(v, d = 0) {
  return round(v, d).toFixed(d);
}

function signed(v, d = 0, unit = '') {
  const r = round(v, d);
  const s = (r === 0 ? 0 : r).toFixed(d);
  return `${r > 0 ? '+' : ''}${s}${unit}`;
}

function safeMax(arr, fallback = 0) {
  let m = -Infinity;
  for (const v of arr || []) if (Number.isFinite(v) && v > m) m = v;
  return m === -Infinity ? fallback : m;
}

function safeMin(arr, fallback = 0) {
  let m = Infinity;
  for (const v of arr || []) if (Number.isFinite(v) && v < m) m = v;
  return m === Infinity ? fallback : m;
}

function mean(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// --------------------------------------------------------
// DATES — ride dates are stored as local "YYYY-MM-DD HH:MM"
// --------------------------------------------------------
function parseSafeDate(dStr) {
  if (!dStr) return new Date();
  if (dStr instanceof Date) return dStr;
  const s = String(dStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d) ? new Date() : d;
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatFullDateWithDay(dStr) {
  if (!dStr) return 'Unknown Date & Time';
  const d = parseSafeDate(dStr);
  const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
  const parts = String(dStr).trim().split(' ');
  const timePart = parts[1] ? ` at ${parts[1]}` : '';
  return `${parts[0]} (${dayName})${timePart}`;
}

function formatNiceDate(dStr, withTime = true) {
  const d = parseSafeDate(dStr);
  const date = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const t = String(dStr).split(' ')[1];
  return withTime && t ? `${date} · ${t}` : date;
}

function monthLabel(dStr) {
  return parseSafeDate(dStr).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// "1:05:12" or "45:30"
function formatDuration(sec) {
  sec = Math.max(0, Math.round(num(sec)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// "12h 05m" — for totals
function formatHours(sec) {
  sec = Math.max(0, Math.round(num(sec)));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function rideDuration(w) {
  return w && w.moving_sec > 0 ? formatDuration(w.moving_sec) : (w && w.duration_str) || '--';
}

function formatRecoveryGap(msGap) {
  if (msGap <= 0) return 'back-to-back (no recovery gap)';
  const hours = msGap / 3600000;
  if (hours < 24) return `${hours.toFixed(1)} hour(s) recovery gap`;
  return `${(hours / 24).toFixed(1)} day(s) (${Math.round(hours)} hrs) recovery gap`;
}

function relativeTime(dateLike) {
  const t = parseSafeDate(dateLike).getTime();
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return parseSafeDate(dateLike).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Monday 00:00 of the week containing d
function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Google encoded-polyline decoder (Strava map.summary_polyline) → [[lat, lng], …]
function decodePolyline(str) {
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (str && index < str.length) {
    for (const axis of [0, 1]) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// --------------------------------------------------------
// AI TEXT → SAFE HTML (escape first, then a small markdown subset)
// --------------------------------------------------------
function stripLatex(text) {
  return text
    .replace(/^\s*[%|]{2,}.*$/gm, '')
    .replace(/\$\\text\{([^}]+)\}\$/g, '$1')
    .replace(/\$\\mathbf\{([^}]+)\}\$/g, '$1')
    .replace(/\$\\sim\s*/g, '~')
    .replace(/\\text\{([^}]+)\}/g, '$1')
    .replace(/\\mathbf\{([^}]+)\}/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\\div/g, '÷')
    .replace(/\\approx/g, '≈')
    .replace(/\$([^$\n]+)\$/g, '$1');
}

function mdInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(raw) {
  if (!raw) return '';
  const lines = escapeHtml(stripLatex(String(raw).replace(/\r/g, ''))).split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${mdInline(para.join('<br>'))}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const tag = m[1].length <= 2 ? 'h3' : 'h4';
      html += `<${tag}>${mdInline(m[2].replace(/#+\s*$/, ''))}</${tag}>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${mdInline(m[1])}</li>`;
      continue;
    }
    if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { closeList(); html += `<ol start="${m[1]}">`; list = 'ol'; }
      html += `<li>${mdInline(m[2])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html;
}

// Plain-text version for the PDF
function markdownToPlain(raw) {
  return stripLatex(String(raw || '').replace(/\r/g, ''))
    .replace(/[→]/g, '->').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=').replace(/[≈]/g, '~')
    .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[•]/g, '-')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[*]\s+/gm, '- ')
    .replace(/[*#$`]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E×÷°·]/g, '');
}
