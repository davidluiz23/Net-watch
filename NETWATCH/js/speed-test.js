/**
 * Functional HTTP throughput Speed Test engine.
 * Measures real download speed (streaming Fetch reader), real upload speed (XHR upload progress),
 * and pre-test latency + jitter. Never fabricates throughput values.
 */

import { storage, STORES } from './storage.js';
import { calculateRfc3550Jitter, validateEndpointUrl } from './utils.js';

export class SpeedTestEngine {
  constructor({ onProgress, onComplete, onError, onEvent }) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onEvent = onEvent;

    this.running = false;
    this.abortController = null;
    this.activeXhr = null;
    this.persistEnabled = true;
  }

  setPersistEnabled(enabled) {
    this.persistEnabled = Boolean(enabled);
  }

  isRunning() {
    return this.running;
  }

  abort() {
    if (!this.running) return;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.activeXhr) {
      this.activeXhr.abort();
      this.activeXhr = null;
    }
    this.running = false;
    this.onEvent('warn', 'Speed test aborted by user.');
  }

  async run(config) {
    if (this.running) return;
    if (!navigator.onLine) {
      this.onError('Cannot run speed test while browser is offline.');
      return;
    }

    const downUrl = config.provider === 'custom'
      ? config.customDownUrl
      : `https://speed.cloudflare.com/__down?bytes=${config.downBytes}`;
    const upUrl = config.provider === 'custom'
      ? config.customUpUrl
      : 'https://speed.cloudflare.com/__up';

    const downCheck = validateEndpointUrl(downUrl);
    const upCheck = validateEndpointUrl(upUrl);
    if (!downCheck.valid) {
      this.onError(`Invalid download endpoint: ${downCheck.error}`);
      return;
    }
    if (!upCheck.valid) {
      this.onError(`Invalid upload endpoint: ${upCheck.error}`);
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let latencyMs = null;
    let jitterMs = null;
    let downloadMbps = null;
    let uploadMbps = null;

    try {
      this.onEvent('info', `Starting speed test (${config.provider})...`);

      // Phase 1: Latency & Jitter (3 quick HTTP probes)
      this.onProgress({ phase: 'LATENCY', pct: 5, speedMbps: 0, status: 'Measuring baseline latency & jitter...' });
      const pingUrl = config.provider === 'custom'
        ? downCheck.url
        : 'https://speed.cloudflare.com/__down?bytes=0';
      const pingRtts = [];

      for (let i = 0; i < 3; i += 1) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const t0 = performance.now();
        const u = new URL(pingUrl);
        u.searchParams.set('_st', `${Date.now()}-${i}`);
        const res = await fetch(u.toString(), { cache: 'no-store', signal });
        if (!res.ok) throw new Error(`Latency probe HTTP ${res.status}`);
        await res.arrayBuffer();
        pingRtts.push(performance.now() - t0);
        this.onProgress({
          phase: 'LATENCY',
          pct: 5 + (i + 1) * 5,
          speedMbps: 0,
          latencyMs: pingRtts[pingRtts.length - 1],
          status: `Latency probe ${i + 1}/3...`
        });
      }

      latencyMs = pingRtts.reduce((a, b) => a + b, 0) / pingRtts.length;
      jitterMs = calculateRfc3550Jitter(pingRtts);

      const maxPhaseMs = config.maxPhaseMs || 4000;

      // Phase 2: Download Test
      this.onProgress({
        phase: 'DOWNLOAD',
        pct: 22,
        speedMbps: 0,
        latencyMs,
        jitterMs,
        status: 'Measuring download throughput...'
      });
      downloadMbps = await this._measureDownload(downCheck.url, config.downBytes, maxPhaseMs, signal, (liveMbps, frac) => {
        this.onProgress({
          phase: 'DOWNLOAD',
          pct: 22 + Math.round(frac * 38),
          speedMbps: liveMbps,
          downloadMbps: liveMbps,
          latencyMs,
          jitterMs,
          status: `Downloading (${(frac * 100).toFixed(0)}%)...`
        });
      });

      // Phase 3: Upload Test
      this.onProgress({
        phase: 'UPLOAD',
        pct: 62,
        speedMbps: 0,
        downloadMbps,
        latencyMs,
        jitterMs,
        status: 'Measuring upload throughput...'
      });
      uploadMbps = await this._measureUpload(upCheck.url, config.upBytes, maxPhaseMs, signal, (liveMbps, frac) => {
        this.onProgress({
          phase: 'UPLOAD',
          pct: 62 + Math.round(frac * 36),
          speedMbps: liveMbps,
          downloadMbps,
          uploadMbps: liveMbps,
          latencyMs,
          jitterMs,
          status: `Uploading (${(frac * 100).toFixed(0)}%)...`
        });
      });

      const result = {
        timestamp: Date.now(),
        provider: config.provider,
        downloadMbps,
        uploadMbps,
        latencyMs,
        jitterMs,
        downBytes: config.downBytes,
        upBytes: config.upBytes
      };

      if (this.persistEnabled) {
        await storage.addRecord(STORES.SPEEDS, result);
      }

      this.onProgress({
        phase: 'COMPLETE',
        pct: 100,
        speedMbps: downloadMbps,
        downloadMbps,
        uploadMbps,
        latencyMs,
        jitterMs,
        status: 'Speed test completed successfully.'
      });
      this.onEvent('ok', `Speed test complete: ↓ ${downloadMbps.toFixed(2)} Mbps / ↑ ${uploadMbps.toFixed(2)} Mbps (${latencyMs.toFixed(1)} ms)`);
      this.onComplete(result);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        this.onProgress({ phase: 'ABORTED', pct: 0, speedMbps: 0, status: 'Test aborted.' });
      } else {
        const msg = err?.message || 'Transfer failed (check CORS or connectivity)';
        this.onEvent('error', `Speed test failed: ${msg}`);
        this.onError(msg);
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.activeXhr = null;
    }
  }

  async _measureDownload(url, expectedBytes, maxPhaseMs, signal, onChunk) {
    const reqUrl = new URL(url);
    reqUrl.searchParams.set('_dl', `${Date.now()}`);

    const phaseCtrl = new AbortController();
    let timeCapped = false;
    const onParentAbort = () => phaseCtrl.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });

    const capTimer = window.setTimeout(() => {
      timeCapped = true;
      phaseCtrl.abort();
    }, maxPhaseMs);

    const tStart = performance.now();
    let received = 0;

    try {
      const res = await fetch(reqUrl.toString(), { cache: 'no-store', signal: phaseCtrl.signal });
      if (!res.ok) throw new Error(`Download HTTP ${res.status}`);

      const totalHeader = Number(res.headers.get('content-length')) || expectedBytes;

      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          const elapsedMs = performance.now() - tStart;
          const elapsedSec = Math.max(0.05, elapsedMs / 1000);
          const mbps = (received * 8) / (elapsedSec * 1_000_000);
          const byteFrac = received / Math.max(1, totalHeader);
          const timeFrac = elapsedMs / maxPhaseMs;
          onChunk(mbps, Math.min(1, Math.max(byteFrac, timeFrac)));
        }
      } else {
        const buf = await res.arrayBuffer();
        received = buf.byteLength;
      }
    } catch (err) {
      if (!(timeCapped && !signal.aborted && received > 0 && err?.name === 'AbortError')) {
        throw err;
      }
    } finally {
      window.clearTimeout(capTimer);
      signal.removeEventListener('abort', onParentAbort);
    }

    const totalSec = Math.max(0.01, (performance.now() - tStart) / 1000);
    return (received * 8) / (totalSec * 1_000_000);
  }

  _measureUpload(url, byteSize, maxPhaseMs, signal, onProgress) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      // Generate random-ish binary payload without exceeding crypto.getRandomValues 64KB limit
      const payload = new Uint8Array(byteSize);
      const chunk = new Uint8Array(65536);
      crypto.getRandomValues(chunk);
      for (let offset = 0; offset < byteSize; offset += chunk.length) {
        const sliceLen = Math.min(chunk.length, byteSize - offset);
        payload.set(chunk.subarray(0, sliceLen), offset);
      }

      const xhr = new XMLHttpRequest();
      this.activeXhr = xhr;
      const tStart = performance.now();
      let lastLoaded = 0;
      let lastElapsedSec = 0.05;
      let timeCapped = false;

      const capTimer = window.setTimeout(() => {
        if (lastLoaded > 0) {
          timeCapped = true;
          xhr.abort();
        }
      }, maxPhaseMs);

      const onAbortSignal = () => {
        window.clearTimeout(capTimer);
        xhr.abort();
      };
      signal.addEventListener('abort', onAbortSignal, { once: true });

      xhr.open('POST', url, true);
      xhr.timeout = Math.max(15000, maxPhaseMs + 5000);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        const elapsedMs = performance.now() - tStart;
        lastLoaded = evt.loaded;
        lastElapsedSec = Math.max(0.05, elapsedMs / 1000);
        const mbps = (evt.loaded * 8) / (lastElapsedSec * 1_000_000);
        const byteFrac = evt.loaded / evt.total;
        const timeFrac = elapsedMs / maxPhaseMs;
        onProgress(mbps, Math.min(1, Math.max(byteFrac, timeFrac)));
      };

      xhr.onload = () => {
        window.clearTimeout(capTimer);
        signal.removeEventListener('abort', onAbortSignal);
        this.activeXhr = null;
        if (xhr.status >= 200 && xhr.status < 400) {
          const totalSec = Math.max(0.01, (performance.now() - tStart) / 1000);
          resolve((byteSize * 8) / (totalSec * 1_000_000));
        } else {
          reject(new Error(`Upload HTTP ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        window.clearTimeout(capTimer);
        signal.removeEventListener('abort', onAbortSignal);
        this.activeXhr = null;
        reject(new Error('Upload network/CORS error'));
      };

      xhr.ontimeout = () => {
        window.clearTimeout(capTimer);
        signal.removeEventListener('abort', onAbortSignal);
        this.activeXhr = null;
        reject(new Error('Upload timed out'));
      };

      xhr.onabort = () => {
        window.clearTimeout(capTimer);
        signal.removeEventListener('abort', onAbortSignal);
        this.activeXhr = null;
        if (timeCapped && !signal.aborted && lastLoaded > 0) {
          resolve((lastLoaded * 8) / (lastElapsedSec * 1_000_000));
        } else {
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };

      xhr.send(new Blob([payload], { type: 'application/octet-stream' }));
    });
  }
}
