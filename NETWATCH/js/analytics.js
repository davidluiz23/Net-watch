/**
 * Network Analytics & Reporting module.
 * Aggregates persisted IndexedDB telemetry across selectable windows (15m, 1h, 24h, 7d),
 * offloads heavy aggregation to a Web Worker when enabled, renders 4 charts,
 * and exports CSV, JSON, and downloadable HTML reports.
 */

import { storage, STORES } from './storage.js';
import { drawBarChart, drawLineChart } from './chart-renderer.js';
import { calculateRfc3550Jitter, downloadBlob, escapeHtml, formatDateTime, formatMs } from './utils.js';

const RANGE_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
};

export class AnalyticsEngine {
  constructor() {
    this.rangeKey = '15m';
    this.useWorker = true;
    this.worker = null;
    this.workerReqId = 0;
    this.pendingWorker = new Map();

    this._initWorker();
  }

  _initWorker() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./workers/telemetry-worker.js', import.meta.url));
      this.worker.onmessage = (event) => {
        const { id, result } = event.data || {};
        const resolver = this.pendingWorker.get(id);
        if (resolver) {
          this.pendingWorker.delete(id);
          resolver(result);
        }
      };
      this.worker.onerror = () => {
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  setUseWorker(enabled) {
    this.useWorker = Boolean(enabled);
  }

  setRange(rangeKey) {
    if (RANGE_MS[rangeKey]) {
      this.rangeKey = rangeKey;
    }
  }

  async _analyzeInWorkerOrMain(samples, incidents, rangeMs) {
    const now = Date.now();
    if (this.useWorker && this.worker) {
      const id = ++this.workerReqId;
      return new Promise((resolve) => {
        this.pendingWorker.set(id, resolve);
        this.worker.postMessage({
          id,
          type: 'ANALYZE_WINDOW',
          payload: { samples, incidents, rangeMs, now }
        });
      });
    }

    // Main-thread fallback
    const cutoff = now - rangeMs;
    const prevCutoff = cutoff - rangeMs;
    const current = samples.filter((s) => s.timestamp >= cutoff);
    const previous = samples.filter((s) => s.timestamp >= prevCutoff && s.timestamp < cutoff);
    const okCurrent = current.filter((s) => s.ok && Number.isFinite(s.rttMs));
    const okPrev = previous.filter((s) => s.ok && Number.isFinite(s.rttMs));

    const avgLatency = okCurrent.length ? okCurrent.reduce((a, b) => a + b.rttMs, 0) / okCurrent.length : null;
    const prevAvgLatency = okPrev.length ? okPrev.reduce((a, b) => a + b.rttMs, 0) / okPrev.length : null;
    const avgJitter = calculateRfc3550Jitter(okCurrent.map((s) => s.rttMs));
    const availabilityPct = current.length ? (okCurrent.length / current.length) * 100 : null;
    const windowIncidents = incidents.filter((i) => i.timestamp >= cutoff);

    const bucketCount = 12;
    const bucketSize = rangeMs / bucketCount;
    const availabilityBuckets = [];
    const interruptionBuckets = [];
    for (let i = 0; i < bucketCount; i += 1) {
      const start = cutoff + i * bucketSize;
      const end = start + bucketSize;
      const inB = current.filter((s) => s.timestamp >= start && s.timestamp < end);
      const okB = inB.filter((s) => s.ok);
      const incB = windowIncidents.filter((inc) => inc.timestamp >= start && inc.timestamp < end);
      const d = new Date(start);
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      availabilityBuckets.push({ label, value: inB.length ? (okB.length / inB.length) * 100 : 0 });
      interruptionBuckets.push({ label, value: incB.length });
    }

    return {
      count: current.length,
      avgLatency,
      prevAvgLatency,
      latencyDelta: avgLatency !== null && prevAvgLatency !== null ? avgLatency - prevAvgLatency : null,
      avgJitter,
      availabilityPct,
      interruptionCount: windowIncidents.length,
      availabilityBuckets,
      interruptionBuckets
    };
  }

  async refresh(liveSamples = [], liveIncidents = []) {
    const rangeMs = RANGE_MS[this.rangeKey];
    const minTs = Date.now() - rangeMs * 2;

    const [dbSamples, dbSpeeds, dbIncidents] = await Promise.all([
      storage.getSince(STORES.SAMPLES, minTs),
      storage.getSince(STORES.SPEEDS, Date.now() - rangeMs),
      storage.getSince(STORES.INCIDENTS, Date.now() - rangeMs)
    ]);

    const samples = dbSamples.length > 0 ? dbSamples : liveSamples;
    const incidents = dbIncidents.length > 0 ? dbIncidents : liveIncidents;

    const summary = await this._analyzeInWorkerOrMain(samples, incidents, rangeMs);
    this._renderSummary(summary);
    this._renderCharts(samples, dbSpeeds, summary, rangeMs);
  }

  _renderSummary(summary) {
    const countEl = document.getElementById('ana-count');
    const deltaEl = document.getElementById('ana-lat-delta');
    const jitterEl = document.getElementById('ana-jitter-avg');
    const availEl = document.getElementById('ana-availability');
    const incEl = document.getElementById('ana-interruptions');

    if (countEl) countEl.textContent = String(summary.count);
    if (jitterEl) jitterEl.textContent = formatMs(summary.avgJitter);
    if (availEl) availEl.textContent = summary.availabilityPct !== null ? `${summary.availabilityPct.toFixed(1)}%` : '—';
    if (incEl) incEl.textContent = String(summary.interruptionCount);

    if (deltaEl) {
      if (summary.avgLatency === null) {
        deltaEl.textContent = '—';
      } else if (summary.latencyDelta === null) {
        deltaEl.textContent = `${summary.avgLatency.toFixed(1)} ms (no prior)`;
      } else {
        const sign = summary.latencyDelta >= 0 ? '+' : '';
        deltaEl.textContent = `${summary.avgLatency.toFixed(1)} ms (${sign}${summary.latencyDelta.toFixed(1)})`;
      }
    }
  }

  _renderCharts(samples, speeds, summary, rangeMs) {
    const cutoff = Date.now() - rangeMs;
    const inWin = samples.filter((s) => s.timestamp >= cutoff);

    // Compute rolling jitter series from samples
    const rttPoints = [];
    const jitterPoints = [];
    let j = 0;
    let prevRtt = null;
    for (const s of inWin) {
      if (s.ok && Number.isFinite(s.rttMs)) {
        rttPoints.push({ t: s.timestamp, y: s.rttMs });
        if (prevRtt !== null) {
          j += (Math.abs(s.rttMs - prevRtt) - j) / 16;
          jitterPoints.push({ t: s.timestamp, y: j });
        }
        prevRtt = s.rttMs;
      }
    }

    const latCanvas = document.getElementById('analytics-latency-canvas');
    if (latCanvas) {
      drawLineChart(latCanvas, [
        { label: 'Latency (ms)', color: '#00E5FF', data: rttPoints },
        { label: 'Jitter (ms)', color: '#8B5CF6', data: jitterPoints }
      ], { unit: 'ms', minZero: true });
    }

    const speedCanvas = document.getElementById('analytics-speed-canvas');
    if (speedCanvas) {
      drawLineChart(speedCanvas, [
        { label: 'Download (Mbps)', color: '#00E5FF', data: speeds.map((s) => ({ t: s.timestamp, y: s.downloadMbps })) },
        { label: 'Upload (Mbps)', color: '#8B5CF6', data: speeds.map((s) => ({ t: s.timestamp, y: s.uploadMbps })) }
      ], { unit: 'Mbps', minZero: true });
    }

    const availCanvas = document.getElementById('analytics-availability-canvas');
    if (availCanvas) {
      drawBarChart(
        availCanvas,
        summary.count > 0 ? summary.availabilityBuckets : [],
        { maxVal: 100, unit: '%', color: '#10B981' }
      );
    }

    const intCanvas = document.getElementById('analytics-interruptions-canvas');
    if (intCanvas) {
      drawBarChart(
        intCanvas,
        summary.count > 0 || summary.interruptionCount > 0 ? summary.interruptionBuckets : [],
        { unit: '', color: '#EF4444' }
      );
    }
  }

  async exportReport(format, liveSamples = [], liveIncidents = []) {
    const [samples, speeds, incidents, alerts] = await Promise.all([
      storage.getAll(STORES.SAMPLES, 2000),
      storage.getAll(STORES.SPEEDS, 500),
      storage.getAll(STORES.INCIDENTS, 500),
      storage.getAll(STORES.ALERTS, 500)
    ]);

    const exportData = {
      generatedAt: new Date().toISOString(),
      range: this.rangeKey,
      samples: samples.length ? samples : liveSamples,
      speedTests: speeds,
      incidents: incidents.length ? incidents : liveIncidents,
      alerts
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    if (format === 'json') {
      downloadBlob(`netwatch-report-${stamp}.json`, JSON.stringify(exportData, null, 2), 'application/json');
      return;
    }

    if (format === 'csv') {
      const header = 'timestamp_iso,endpoint,ok,status,rtt_ms,error\n';
      const rows = exportData.samples
        .map((s) => [
          new Date(s.timestamp).toISOString(),
          `"${String(s.endpointName || '').replace(/"/g, '""')}"`,
          s.ok,
          s.status ?? '',
          s.rttMs !== null && s.rttMs !== undefined ? s.rttMs.toFixed(2) : '',
          `"${String(s.error || '').replace(/"/g, '""')}"`
        ].join(','))
        .join('\n');
      downloadBlob(`netwatch-telemetry-${stamp}.csv`, header + rows, 'text/csv;charset=utf-8');
      return;
    }

    if (format === 'html') {
      const okRtts = exportData.samples.filter((s) => s.ok && Number.isFinite(s.rttMs)).map((s) => s.rttMs);
      const avgLat = okRtts.length ? (okRtts.reduce((a, b) => a + b, 0) / okRtts.length).toFixed(2) : 'N/A';
      const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>NETWATCH Performance Report</title>
<style>body{font-family:system-ui,sans-serif;background:#080B12;color:#E5E7EB;padding:32px;max-width:960px;margin:auto}
h1,h2{color:#00E5FF}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:8px;border-bottom:1px solid #1E293B;text-align:left;font-size:13px}
.card{background:#111827;padding:16px;border-radius:8px;margin-bottom:16px}</style></head>
<body>
<h1>NETWATCH Network Performance Report</h1>
<p>Generated: ${escapeHtml(exportData.generatedAt)}</p>
<div class="card"><strong>Total Probe Samples:</strong> ${exportData.samples.length} | <strong>Average Latency:</strong> ${escapeHtml(avgLat)} ms | <strong>Speed Tests:</strong> ${exportData.speedTests.length} | <strong>Incidents:</strong> ${exportData.incidents.length}</div>
<h2>Recent Speed Tests</h2>
<table><thead><tr><th>Time</th><th>Download</th><th>Upload</th><th>Latency</th><th>Jitter</th></tr></thead><tbody>
${exportData.speedTests.slice(-20).reverse().map((t) => `<tr><td>${escapeHtml(formatDateTime(t.timestamp))}</td><td>${t.downloadMbps.toFixed(2)} Mbps</td><td>${t.uploadMbps.toFixed(2)} Mbps</td><td>${t.latencyMs.toFixed(1)} ms</td><td>${t.jitterMs !== null ? t.jitterMs.toFixed(1) + ' ms' : '—'}</td></tr>`).join('')}
</tbody></table>
<h2>Recent Incidents</h2>
<table><thead><tr><th>Time</th><th>Title</th><th>Detail</th></tr></thead><tbody>
${exportData.incidents.slice(-20).reverse().map((i) => `<tr><td>${escapeHtml(formatDateTime(i.timestamp))}</td><td>${escapeHtml(i.title)}</td><td>${escapeHtml(i.detail)}</td></tr>`).join('')}
</tbody></table>
</body></html>`;
      downloadBlob(`netwatch-performance-report-${stamp}.html`, html, 'text/html;charset=utf-8');
    }
  }
}
