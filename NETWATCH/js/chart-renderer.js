/**
 * Interactive Canvas 2D chart renderer for NETWATCH.
 * Supports multi-series line charts, bar charts, high-DPI scaling, and hover tooltips.
 */

import { formatTime } from './utils.js';

const chartRegistry = new WeakMap();

function ensureInteractiveListeners(canvas) {
  if (chartRegistry.has(canvas)) return chartRegistry.get(canvas);

  const state = {
    hoverX: null,
    hoverY: null,
    drawFn: null
  };

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    state.hoverX = e.clientX - rect.left;
    state.hoverY = e.clientY - rect.top;
    if (state.drawFn) state.drawFn();
  });

  canvas.addEventListener('mouseleave', () => {
    state.hoverX = null;
    state.hoverY = null;
    if (state.drawFn) state.drawFn();
  });

  chartRegistry.set(canvas, state);
  return state;
}

function prepCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function drawTooltipBox(ctx, canvasW, x, y, lines) {
  ctx.save();
  ctx.font = '11px JetBrains Mono, monospace';
  const lineH = 16;
  const padX = 10;
  const padY = 7;
  const maxW = Math.max(...lines.map((l) => ctx.measureText(l.text).width));
  const boxW = maxW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;

  const bx = x + 14 + boxW > canvasW ? Math.max(8, x - boxW - 14) : x + 14;
  const by = Math.max(8, y - boxH / 2);

  ctx.fillStyle = 'rgba(13, 19, 31, 0.94)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, boxW, boxH, 6);
  ctx.fill();
  ctx.stroke();

  lines.forEach((line, idx) => {
    ctx.fillStyle = line.color || '#E5E7EB';
    ctx.textAlign = 'left';
    ctx.fillText(line.text, bx + padX, by + padY + 11 + idx * lineH);
  });
  ctx.restore();
}

/**
 * Draws an interactive multi-series time-series line chart.
 */
export function drawLineChart(canvas, seriesList, options = {}) {
  const state = ensureInteractiveListeners(canvas);
  state.drawFn = () => renderLineChart(canvas, seriesList, options, state);
  state.drawFn();
}

function renderLineChart(canvas, seriesList, options, state) {
  const prep = prepCanvas(canvas);
  if (!prep) return;
  const { ctx, width, height } = prep;
  const unit = options.unit ?? 'ms';

  const allPoints = seriesList.flatMap((s) => s.data.filter((d) => d.y !== null && Number.isFinite(d.y)));
  if (allPoints.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No telemetry data in selected range', width / 2, height / 2);
    return;
  }

  const pad = { top: 24, right: 16, bottom: 28, left: 52 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = Math.max(40, height - pad.top - pad.bottom);

  const values = allPoints.map((p) => p.y);
  let yMin = options.minZero ? 0 : Math.min(...values);
  let yMax = Math.max(...values);
  if (yMax === yMin) {
    yMax += 10;
    if (!options.minZero) yMin = Math.max(0, yMin - 5);
  }
  const yPad = (yMax - yMin) * 0.12;
  yMax += yPad;
  if (!options.minZero) yMin = Math.max(0, yMin - yPad * 0.5);

  const times = allPoints.map((p) => p.t);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times) === tMin ? tMin + 1000 : Math.max(...times);

  // Horizontal grid lines & Y labels
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1;
  ctx.font = '10.5px JetBrains Mono, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';

  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const ratio = i / ticks;
    const y = pad.top + plotH * (1 - ratio);
    const val = yMin + (yMax - yMin) * ratio;

    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    ctx.fillText(`${val.toFixed(val >= 100 ? 0 : 1)}${unit ? ` ${unit}` : ''}`, pad.left - 6, y + 3);
  }

  // X axis labels
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4;
    const x = pad.left + plotW * ratio;
    const t = tMin + (tMax - tMin) * ratio;
    ctx.fillText(formatTime(t), x, height - 8);
  }

  // Draw series and collect plotted coords for hover
  const plottedSeries = [];
  for (const series of seriesList) {
    const coords = [];
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;

    for (const pt of series.data) {
      if (pt.y === null || !Number.isFinite(pt.y)) {
        started = false;
        continue;
      }
      const x = pad.left + ((pt.t - tMin) / (tMax - tMin)) * plotW;
      const y = pad.top + plotH - ((pt.y - yMin) / (yMax - yMin)) * plotH;
      coords.push({ x, y, t: pt.t, val: pt.y });
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    plottedSeries.push({ label: series.label, color: series.color, coords });
  }

  // Legend
  let lx = pad.left;
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'left';
  for (const series of seriesList) {
    ctx.fillStyle = series.color;
    ctx.fillRect(lx, 6, 10, 3);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(series.label, lx + 14, 11);
    lx += ctx.measureText(series.label).width + 30;
  }

  // Interactive hover crosshair & nearest-point tooltip
  if (
    state.hoverX !== null &&
    state.hoverX >= pad.left &&
    state.hoverX <= pad.left + plotW &&
    state.hoverY >= pad.top &&
    state.hoverY <= pad.top + plotH
  ) {
    const hoverLines = [];
    let snapX = state.hoverX;
    let snapTime = null;

    for (const ps of plottedSeries) {
      let best = null;
      let bestDist = Infinity;
      for (const c of ps.coords) {
        const d = Math.abs(c.x - state.hoverX);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (best && bestDist <= 36) {
        snapX = best.x;
        snapTime = best.t;
        hoverLines.push({
          text: `${ps.label}: ${best.val.toFixed(1)} ${unit}`.trim(),
          color: ps.color
        });
        ctx.beginPath();
        ctx.arc(best.x, best.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = ps.color;
        ctx.fill();
      }
    }

    if (hoverLines.length > 0) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(229, 231, 235, 0.35)';
      ctx.beginPath();
      ctx.moveTo(snapX, pad.top);
      ctx.lineTo(snapX, pad.top + plotH);
      ctx.stroke();
      ctx.restore();

      if (snapTime !== null) {
        hoverLines.unshift({ text: formatTime(snapTime), color: '#94a3b8' });
      }
      drawTooltipBox(ctx, width, snapX, state.hoverY, hoverLines);
    }
  }
}

/**
 * Draws an interactive bar chart for bucketed availability or interruptions.
 */
export function drawBarChart(canvas, buckets, options = {}) {
  const state = ensureInteractiveListeners(canvas);
  state.drawFn = () => renderBarChart(canvas, buckets, options, state);
  state.drawFn();
}

function renderBarChart(canvas, buckets, options, state) {
  const prep = prepCanvas(canvas);
  if (!prep) return;
  const { ctx, width, height } = prep;

  if (!buckets || buckets.length === 0) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No bucketed data in selected range', width / 2, height / 2);
    return;
  }

  const pad = { top: 20, right: 14, bottom: 26, left: 42 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = Math.max(40, height - pad.top - pad.bottom);

  const maxVal = options.maxVal ?? Math.max(1, ...buckets.map((b) => b.value));

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.font = '10.5px JetBrains Mono, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';

  for (let i = 0; i <= 4; i += 1) {
    const r = i / 4;
    const y = pad.top + plotH * (1 - r);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${(maxVal * r).toFixed(0)}${options.unit || ''}`, pad.left - 6, y + 3);
  }

  const barStep = plotW / buckets.length;
  const barW = Math.max(4, Math.min(28, barStep * 0.65));
  let hoveredBar = null;

  buckets.forEach((b, idx) => {
    const x = pad.left + idx * barStep + (barStep - barW) / 2;
    const h = (b.value / maxVal) * plotH;
    const y = pad.top + plotH - h;

    const isHover =
      state.hoverX !== null &&
      state.hoverX >= pad.left + idx * barStep &&
      state.hoverX < pad.left + (idx + 1) * barStep;

    if (isHover) {
      hoveredBar = { b, x: x + barW / 2, y };
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(pad.left + idx * barStep, pad.top, barStep, plotH);
    }

    ctx.fillStyle = options.color || '#00e5ff';
    ctx.fillRect(x, y, barW, Math.max(1, h));
  });

  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'left';
  ctx.fillText(buckets[0].label, pad.left, height - 7);
  ctx.textAlign = 'right';
  ctx.fillText(buckets[buckets.length - 1].label, pad.left + plotW, height - 7);

  if (hoveredBar) {
    drawTooltipBox(ctx, width, hoveredBar.x, Math.max(pad.top + 12, hoveredBar.y), [
      { text: `Window: ${hoveredBar.b.label}`, color: '#94a3b8' },
      { text: `${hoveredBar.b.value.toFixed(1)}${options.unit || ''}`, color: options.color || '#00e5ff' }
    ]);
  }
}
