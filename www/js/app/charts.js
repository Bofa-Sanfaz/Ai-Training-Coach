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
