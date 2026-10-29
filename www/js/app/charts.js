'use strict';
// --------------------------------------------------------
// PLOTLY HELPERS (theme-aware, touch friendly)
// --------------------------------------------------------
const PLOT_CONFIG = { responsive: true, displayModeBar: false, scrollZoom: false, staticPlot: false };

function plotLayout(extra = {}) {
  const grid = cssVar('--chart-grid') || '#eef2f7';
  const text = cssVar('--chart-text') || '#64748b';
  const base = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Inter, -apple-system, Segoe UI, Roboto, sans-serif', size: 11, color: text },
    margin: { l: 34, r: 12, t: 10, b: 30 },
    showlegend: false,
    dragmode: false,
    hovermode: 'x unified',
    hoverlabel: { bgcolor: '#0f172a', bordercolor: '#0f172a', font: { color: '#f8fafc', size: 12 } },
    xaxis: { fixedrange: true, showgrid: false, zeroline: false, linecolor: grid, tickcolor: grid },
    yaxis: { fixedrange: true, showgrid: true, gridcolor: grid, zeroline: false }
  };
  const merged = Object.assign({}, base, extra);
  merged.xaxis = Object.assign({}, base.xaxis, extra.xaxis || {});
  merged.yaxis = Object.assign({}, base.yaxis, extra.yaxis || {});
  return merged;
}

function chartEmpty(el, text) {
  if (window.Plotly) Plotly.purge(el);
  el.innerHTML = `<div class="chart-empty">${escapeHtml(text)}</div>`;
}

function plotReady() {
  return !!window.Plotly;
}

// Draw (or redraw) a chart. Plotly.react updates the existing SVG in place, so
// the element must never be emptied by hand between draws — that was the cause
// of charts vanishing after a filter change or when returning to a screen.
// A chart drawn while its screen is hidden has no width, and Plotly then falls back to
// a fixed 700 × 450 canvas that stays wrong after the screen appears (squashed curves,
// cut-off axis). Such draws are parked and done when the screen is shown.
function drawChart(el, traces, layout, config = PLOT_CONFIG) {
  if (!el.offsetParent || el.clientWidth === 0) {
    el.__pending = { traces, layout, config };
    return Promise.resolve(null);
  }
  el.__pending = null;
  const stale = el.querySelector('.chart-empty') || (el._fullLayout && !el.querySelector('.main-svg'));
  if (stale) { Plotly.purge(el); el.innerHTML = ''; }
  const p = Plotly.react(el, traces, layout, config);
  ['plotly_hover', 'plotly_click', 'plotly_unhover'].forEach(ev => el.removeAllListeners && el.removeAllListeners(ev));
  return p;
}

// After a screen or panel becomes visible: draw parked charts and fix any chart whose
// size no longer matches its box. Listeners (hover/click) are re-attached by the next
// render of that screen, which switchTab always does.
function resizeChartsIn(root) {
  if (!window.Plotly || !root) return;
  root.querySelectorAll('.chart').forEach(el => {
    if (!el.offsetParent || el.clientWidth === 0) return;
    if (el.__pending) {
      const { traces, layout, config } = el.__pending;
      drawChart(el, traces, layout, config);
      return;
    }
    const fl = el._fullLayout;
    if (fl && el.layout && !el.layout.width && Math.abs(fl.width - el.clientWidth) > 4) {
      try { Plotly.Plots.resize(el); } catch (_) { /* ignore */ }
    }
  });
}

function smoothStreamArray(arr, windowSize = 5) {
  if (!arr || arr.length < windowSize) return arr || [];
  const half = Math.floor(windowSize / 2);
  const res = new Array(arr.length);
  let sum = 0, count = 0;
  // sliding window
  for (let i = 0; i < Math.min(half, arr.length); i++) { sum += num(arr[i]); count++; }
  for (let i = 0; i < arr.length; i++) {
    const add = i + half;
    if (add < arr.length) { sum += num(arr[add]); count++; }
    const drop = i - half - 1;
    if (drop >= 0) { sum -= num(arr[drop]); count--; }
    res[i] = round(sum / count, 1);
  }
  return res;
}

// Downsample long streams for chart performance (keeps every n-th point)
function strideIndices(n, maxPoints = 1500) {
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

// Re-draw charts after a theme change
function rerenderCharts() {
  if (Router.current === 'trends') renderTrends();
  if (Router.current === 'reports') renderReports();
  if ($('#rideDetail').classList.contains('open')) renderStreamPlot();
}
