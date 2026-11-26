/**
 * Real HTTP latency & availability monitor.
 * Measures actual round-trip time via Fetch + performance.now() with AbortController timeouts,
 * detects latency spikes/fluctuations, and tracks endpoint recovery durations.
 */

import { storage, STORES } from './storage.js';
import { calculateRfc3550Jitter, validateEndpointUrl } from './utils.js';

export class LatencyMonitor {
  constructor({ onSample, onEvent, onFailureSpike, onIncident }) {
    this.onSample = onSample;
    this.onEvent = onEvent;
    this.onFailureSpike = onFailureSpike;
    this.onIncident = onIncident;

    this.endpoints = [];
    this.intervalMs = 5000;
    this.timeoutMs = 4500;
    this.persistEnabled = true;

    this.timerId = null;
    this.isRunning = false;
    this.isPolling = false;
    this.activeControllers = new Set();

    this.samples = [];
    this.endpointStats = new Map();
    this.totalProbes = 0;
    this.failedProbes = 0;
  }

  configure({ endpoints, intervalMs, timeoutMs, persistEnabled }) {
    if (Array.isArray(endpoints)) this.endpoints = endpoints;
    if (typeof intervalMs === 'number') this.intervalMs = Math.max(2000, intervalMs);
    if (typeof timeoutMs === 'number') this.timeoutMs = Math.max(1000, timeoutMs);
    if (typeof persistEnabled === 'boolean') this.persistEnabled = persistEnabled;

    if (this.isRunning) {
      this._scheduleNext();
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.probeAll();
    this._scheduleNext();
  }

  stop() {
    this.isRunning = false;
    if (this.timerId) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    for (const ctrl of this.activeControllers) {
      ctrl.abort();
    }
    this.activeControllers.clear();
  }

  _scheduleNext() {
    if (this.timerId) window.clearInterval(this.timerId);
    if (!this.isRunning) return;
    this.timerId = window.setInterval(() => {
      if (this.isRunning) this.probeAll();
    }, this.intervalMs);
  }

  async probeAll() {
    if (this.isPolling) return [];
    const enabled = this.endpoints.filter((e) => e.enabled);
    if (enabled.length === 0) return [];

    this.isPolling = true;
    try {
      const results = await Promise.all(enabled.map((ep) => this.probeEndpoint(ep)));
      const aggregate = this.getAggregateStats();
      this.onSample({ results, aggregate, samples: this.samples });
      return results;
    } finally {
      this.isPolling = false;
    }
  }

  async probeEndpoint(endpoint) {
    const check = validateEndpointUrl(endpoint.url);
    if (!check.valid) {
      return {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        url: endpoint.url,
        timestamp: Date.now(),
        ok: false,
        rttMs: null,
        error: check.error
      };
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeoutId = window.setTimeout(() => controller.abort(), this.timeoutMs);

    const probeUrl = new URL(check.url);
    probeUrl.searchParams.set('_nw', `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

    const start = performance.now();
    let sample;

    try {
      const response = await fetch(probeUrl.toString(), {
        method: 'GET',
        mode: endpoint.mode || 'cors',
        cache: 'no-store',
        signal: controller.signal
      });
      const rttMs = Math.max(0.5, performance.now() - start);
      const ok = response.ok || response.type === 'opaque';

      sample = {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        url: endpoint.url,
        timestamp: Date.now(),
        ok,
        status: response.status,
        rttMs: ok ? rttMs : null,
        error: ok ? null : `HTTP ${response.status}`
      };
    } catch (err) {
      const elapsed = performance.now() - start;
      const isTimeout = err && err.name === 'AbortError';
      sample = {
        endpointId: endpoint.id,
        endpointName: endpoint.name,
        url: endpoint.url,
        timestamp: Date.now(),
        ok: false,
        status: 0,
        rttMs: null,
        error: isTimeout ? `Timeout (>${this.timeoutMs}ms)` : 'Network/CORS unreachable',
        elapsedMs: elapsed
      };
    } finally {
      window.clearTimeout(timeoutId);
      this.activeControllers.delete(controller);
    }

    this._recordSample(sample);
    return sample;
  }

  _recordSample(sample) {
    this.totalProbes += 1;

    const prev = this.endpointStats.get(sample.endpointId) || {
      id: sample.endpointId,
      name: sample.endpointName,
      url: sample.url,
      rtts: [],
      total: 0,
      fails: 0,
      lastSample: null,
      failingSince: null
    };

    prev.total += 1;

    if (!sample.ok) {
      this.failedProbes += 1;
      prev.fails += 1;
      if (!prev.failingSince) prev.failingSince = sample.timestamp;
      this.onFailureSpike(sample);
    } else if (sample.rttMs !== null) {
      // Detect recovery after previous failure
      if (prev.failingSince) {
        const recoveryMs = sample.timestamp - prev.failingSince;
        prev.failingSince = null;
        if (this.onIncident) {
          this.onIncident({
            type: 'endpoint_recovery',
            severity: 'ok',
            title: `Endpoint Recovered: ${sample.endpointName}`,
            detail: `Responded in ${sample.rttMs.toFixed(1)} ms after ${(recoveryMs / 1000).toFixed(1)}s unreachable`,
            recoveryMs
          });
        }
      }

      // Detect significant latency fluctuation against rolling baseline
      if (prev.rtts.length >= 5) {
        const baseline = prev.rtts.reduce((a, b) => a + b, 0) / prev.rtts.length;
        if (sample.rttMs > Math.max(150, baseline * 2.5)) {
          if (this.onIncident) {
            this.onIncident({
              type: 'latency_spike',
              severity: 'warn',
              title: `Latency Fluctuation: ${sample.endpointName}`,
              detail: `RTT spiked to ${sample.rttMs.toFixed(1)} ms (baseline ${baseline.toFixed(1)} ms)`
            });
          }
        }
      }

      prev.rtts.push(sample.rttMs);
      if (prev.rtts.length > 60) prev.rtts.shift();
    }

    prev.lastSample = sample;
    this.endpointStats.set(sample.endpointId, prev);

    this.samples.push(sample);
    if (this.samples.length > 600) {
      this.samples.shift();
    }

    if (this.persistEnabled) {
      storage.addRecord(STORES.SAMPLES, sample);
    }
  }

  getAggregateStats() {
    const okSamples = this.samples.filter((s) => s.ok && Number.isFinite(s.rttMs));
    const rtts = okSamples.map((s) => s.rttMs);
    const recentRtts = rtts.slice(-40);

    const latestOk = okSamples.length ? okSamples[okSamples.length - 1] : null;
    const min = recentRtts.length ? Math.min(...recentRtts) : null;
    const max = recentRtts.length ? Math.max(...recentRtts) : null;
    const avg = recentRtts.length ? recentRtts.reduce((a, b) => a + b, 0) / recentRtts.length : null;
    const jitter = calculateRfc3550Jitter(recentRtts);
    const failureRatePct = this.totalProbes > 0 ? (this.failedProbes / this.totalProbes) * 100 : 0;

    return {
      latestRtt: latestOk ? latestOk.rttMs : null,
      latestEndpoint: latestOk ? latestOk.endpointName : null,
      min,
      max,
      avg,
      jitter,
      totalProbes: this.totalProbes,
      failedProbes: this.failedProbes,
      failureRatePct
    };
  }

  getEndpointSummaries() {
    return this.endpoints.map((ep) => {
      const stat = this.endpointStats.get(ep.id);
      const rtts = stat ? stat.rtts : [];
      const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
      return {
        ...ep,
        lastSample: stat ? stat.lastSample : null,
        avgRtt: avg,
        failRate: stat && stat.total > 0 ? (stat.fails / stat.total) * 100 : 0
      };
    });
  }
}
