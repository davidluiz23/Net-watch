/**
 * Monitors browser online/offline state, Navigator Connection API,
 * public IP lookup, session uptime, and stability incidents.
 */

import { storage, STORES } from './storage.js';
import { formatDuration } from './utils.js';

export class NetworkMonitor {
  constructor({ onEvent, onStatusChange, onIncident, onIpUpdate }) {
    this.onEvent = onEvent;
    this.onStatusChange = onStatusChange;
    this.onIncident = onIncident;
    this.onIpUpdate = onIpUpdate;

    this.sessionStart = Date.now();
    this.lastStateChange = Date.now();
    this.isOnline = navigator.onLine;
    this.downtimeMs = 0;
    this.offlineSince = this.isOnline ? null : Date.now();

    this.publicIp = null;
    this.ipMeta = null;
    this.incidents = [];
    this.uptimeTimer = null;

    this._handleOnline = this._handleOnline.bind(this);
    this._handleOffline = this._handleOffline.bind(this);
    this._handleConnChange = this._handleConnChange.bind(this);
  }

  start() {
    window.addEventListener('online', this._handleOnline);
    window.addEventListener('offline', this._handleOffline);

    const conn = this.getConnectionInfo();
    if (conn.raw && typeof conn.raw.addEventListener === 'function') {
      conn.raw.addEventListener('change', this._handleConnChange);
    }

    if (!this.uptimeTimer) {
      this.uptimeTimer = window.setInterval(() => this.emitUptime(), 1000);
    }

    this.onStatusChange(this.getStatusSnapshot());
    this.emitUptime();
  }

  stop() {
    window.removeEventListener('online', this._handleOnline);
    window.removeEventListener('offline', this._handleOffline);

    const conn = this.getConnectionInfo();
    if (conn.raw && typeof conn.raw.removeEventListener === 'function') {
      conn.raw.removeEventListener('change', this._handleConnChange);
    }

    if (this.uptimeTimer) {
      window.clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
  }

  getConnectionInfo() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    if (!conn) {
      return {
        supported: false,
        raw: null,
        effectiveType: null,
        type: null,
        downlink: null,
        rtt: null,
        saveData: false
      };
    }

    return {
      supported: true,
      raw: conn,
      effectiveType: conn.effectiveType || null,
      type: conn.type || null,
      downlink: typeof conn.downlink === 'number' ? conn.downlink : null,
      rtt: typeof conn.rtt === 'number' ? conn.rtt : null,
      saveData: Boolean(conn.saveData)
    };
  }

  getSessionStats() {
    const now = Date.now();
    const elapsedMs = Math.max(1000, now - this.sessionStart);
    const currentDown = this.offlineSince ? now - this.offlineSince : 0;
    const totalDown = this.downtimeMs + currentDown;
    const uptimePct = Math.max(0, Math.min(100, ((elapsedMs - totalDown) / elapsedMs) * 100));
    return {
      elapsedMs,
      elapsedFormatted: formatDuration(elapsedMs),
      downtimeMs: totalDown,
      uptimePct
    };
  }

  getStatusSnapshot() {
    return {
      online: this.isOnline,
      connection: this.getConnectionInfo(),
      uptime: this.getSessionStats(),
      publicIp: this.publicIp,
      ipMeta: this.ipMeta
    };
  }

  emitUptime() {
    this.onStatusChange(this.getStatusSnapshot());
  }

  async lookupPublicIp() {
    if (!navigator.onLine) {
      this.publicIp = null;
      this.onIpUpdate({ ip: null, source: null, error: 'Browser is offline' });
      return null;
    }

    // Primary: ipify JSON
    try {
      const res = await fetch('https://api.ipify.org?format=json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ip) {
          this.publicIp = data.ip;
          this.ipMeta = { source: 'api.ipify.org' };
          this.onIpUpdate({ ip: data.ip, source: 'api.ipify.org', error: null });
          this.onEvent('info', `Public IP resolved: ${data.ip} (api.ipify.org)`);
          return data.ip;
        }
      }
    } catch {
      // Fall through to Cloudflare trace
    }

    // Fallback: Cloudflare trace
    try {
      const res = await fetch('https://1.1.1.1/cdn-cgi/trace', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const text = await res.text();
        const ipLine = text.split('\n').find((l) => l.startsWith('ip='));
        const coloLine = text.split('\n').find((l) => l.startsWith('colo='));
        const ip = ipLine ? ipLine.slice(3).trim() : null;
        const colo = coloLine ? coloLine.slice(5).trim() : null;
        if (ip) {
          this.publicIp = ip;
          this.ipMeta = { source: '1.1.1.1/cdn-cgi/trace', colo };
          this.onIpUpdate({ ip, source: 'Cloudflare Trace', colo, error: null });
          this.onEvent('info', `Public IP resolved: ${ip} (Edge ${colo || 'Cloudflare'})`);
          return ip;
        }
      }
    } catch {
      // Unreachable
    }

    this.onIpUpdate({ ip: null, source: null, error: 'Lookup unreachable or blocked' });
    return null;
  }

  recordIncident(incident) {
    const entry = {
      timestamp: Date.now(),
      ...incident
    };
    this.incidents.unshift(entry);
    if (this.incidents.length > 200) this.incidents.pop();
    this.onIncident(entry, this.incidents);
    if (this.persistEnabled) {
      storage.addRecord(STORES.INCIDENTS, entry);
    }
  }

  setPersistEnabled(enabled) {
    this.persistEnabled = Boolean(enabled);
  }

  _handleOnline() {
    const now = Date.now();
    let recoveryMs = null;
    if (this.offlineSince) {
      recoveryMs = now - this.offlineSince;
      this.downtimeMs += recoveryMs;
      this.offlineSince = null;
    }
    this.isOnline = true;
    this.lastStateChange = now;

    this.recordIncident({
      type: 'recovery',
      severity: 'ok',
      title: 'Connection Restored',
      detail: recoveryMs !== null ? `Recovered after ${(recoveryMs / 1000).toFixed(1)}s offline` : 'Navigator reports online',
      recoveryMs
    });
    this.onEvent('ok', 'Network connection restored (navigator.onLine = true)');
    this.onStatusChange(this.getStatusSnapshot());
    this.lookupPublicIp();
  }

  _handleOffline() {
    const now = Date.now();
    this.isOnline = false;
    this.offlineSince = now;
    this.lastStateChange = now;

    this.recordIncident({
      type: 'disconnect',
      severity: 'error',
      title: 'Internet Disconnected',
      detail: 'Browser reported offline state (navigator.onLine = false)',
      recoveryMs: null
    });
    this.onEvent('error', 'Internet disconnection detected (navigator.onLine = false)');
    this.onStatusChange(this.getStatusSnapshot());
  }

  _handleConnChange() {
    const info = this.getConnectionInfo();
    const desc = [info.type, info.effectiveType, info.downlink !== null ? `~${info.downlink} Mbps` : null]
      .filter(Boolean)
      .join(' / ');
    this.onEvent('info', `Network interface changed: ${desc || 'updated'}`);
    this.onStatusChange(this.getStatusSnapshot());
  }
}
