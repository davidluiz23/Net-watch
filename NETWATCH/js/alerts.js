/**
 * Monitoring Alerts engine with configurable thresholds, cooldowns,
 * IndexedDB persistence, and optional Web Notifications API integration.
 */

import { storage, STORES } from './storage.js';
import { escapeHtml, formatDateTime } from './utils.js';

export class AlertsEngine {
  constructor({ onEvent, onBadgeUpdate }) {
    this.onEvent = onEvent;
    this.onBadgeUpdate = onBadgeUpdate;

    this.rules = {
      latencyMaxMs: 200,
      jitterMaxMs: 50,
      failureRateMaxPct: 20,
      cooldownSec: 30,
      notifyDisconnect: true,
      notifyBrowser: false
    };

    this.persistEnabled = true;
    this.alerts = [];
    this.unreadCount = 0;
    this.lastTriggeredByType = new Map();
  }

  configure(rules, persistEnabled = true) {
    this.rules = { ...this.rules, ...rules };
    this.persistEnabled = Boolean(persistEnabled);
  }

  async loadHistory() {
    const saved = await storage.getAll(STORES.ALERTS, 100);
    if (saved.length > 0) {
      this.alerts = saved.reverse();
    }
  }

  async requestNotificationPermission() {
    if (!('Notification' in window)) {
      return { supported: false, permission: 'unsupported' };
    }
    const permission = await Notification.requestPermission();
    return { supported: true, permission };
  }

  evaluateSample({ results, aggregate }) {
    if (aggregate.latestRtt !== null && aggregate.latestRtt > this.rules.latencyMaxMs) {
      this.trigger({
        key: 'high-latency',
        severity: 'warn',
        title: 'High Latency Detected',
        detail: `Measured ${aggregate.latestRtt.toFixed(1)} ms on ${aggregate.latestEndpoint} (threshold: ${this.rules.latencyMaxMs} ms)`
      });
    }

    if (aggregate.jitter !== null && aggregate.jitter > this.rules.jitterMaxMs) {
      this.trigger({
        key: 'high-jitter',
        severity: 'warn',
        title: 'Excessive Jitter',
        detail: `Estimated jitter ${aggregate.jitter.toFixed(1)} ms exceeds ${this.rules.jitterMaxMs} ms`
      });
    }

    if (aggregate.totalProbes >= 5 && aggregate.failureRatePct > this.rules.failureRateMaxPct) {
      this.trigger({
        key: 'failure-rate',
        severity: 'error',
        title: 'Elevated Probe Failure Rate',
        detail: `Probe failures at ${aggregate.failureRatePct.toFixed(1)}% (threshold: ${this.rules.failureRateMaxPct}%)`
      });
    }

    for (const r of results) {
      if (!r.ok) {
        this.trigger({
          key: `endpoint-fail-${r.endpointId}`,
          severity: 'error',
          title: `Endpoint Check Failed: ${r.endpointName}`,
          detail: r.error || 'Probe failed'
        });
      }
    }
  }

  evaluateConnectivity(online) {
    if (!this.rules.notifyDisconnect) return;
    if (!online) {
      this.trigger({
        key: 'disconnect',
        severity: 'error',
        title: 'Internet Disconnection',
        detail: 'Browser lost network connectivity.'
      });
    } else {
      this.trigger({
        key: 'reconnect',
        severity: 'ok',
        title: 'Connection Restored',
        detail: 'Browser network connectivity has returned.'
      });
    }
  }

  trigger({ key, severity, title, detail }) {
    const now = Date.now();
    const last = this.lastTriggeredByType.get(key) || 0;
    if (now - last < this.rules.cooldownSec * 1000) return;

    this.lastTriggeredByType.set(key, now);
    const alert = { timestamp: now, key, severity, title, detail };

    this.alerts.unshift(alert);
    if (this.alerts.length > 150) this.alerts.pop();

    this.unreadCount += 1;
    this.onBadgeUpdate(this.unreadCount);
    this.onEvent(severity, `ALERT: ${title} — ${detail}`);

    if (this.persistEnabled) {
      storage.addRecord(STORES.ALERTS, alert);
    }

    if (this.rules.notifyBrowser && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`NETWATCH: ${title}`, { body: detail });
      } catch {
        // Ignore notification errors in restricted contexts
      }
    }
  }

  markRead() {
    this.unreadCount = 0;
    this.onBadgeUpdate(0);
  }

  async clearAll() {
    this.alerts = [];
    this.unreadCount = 0;
    this.onBadgeUpdate(0);
    await storage.clearStore(STORES.ALERTS);
  }

  renderFeed(container) {
    if (!container) return;
    if (this.alerts.length === 0) {
      container.innerHTML = '<div class="empty-state">No alerts triggered. All monitored thresholds are nominal.</div>';
      return;
    }

    container.innerHTML = this.alerts.slice(0, 60).map((a) => {
      const badgeClass = a.severity === 'error' ? 'badge--error' : a.severity === 'warn' ? 'badge--warn' : 'badge--actual';
      return `
        <div class="alert-item">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
            <strong>${escapeHtml(a.title)}</strong>
            <span class="badge ${badgeClass}">${escapeHtml(a.severity)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(a.detail)}</div>
          <div class="event-time" style="margin-top:4px;">${escapeHtml(formatDateTime(a.timestamp))}</div>
        </div>
      `;
    }).join('');
  }
}
