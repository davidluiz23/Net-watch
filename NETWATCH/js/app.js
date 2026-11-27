/**
 * NETWATCH Main Application Controller
 * Coordinates all monitoring, testing, diagnostics, visualization, analytics, alerts, and UI views.
 */

import { DEFAULT_WIDGETS, loadSettings, resetSettings, saveSettings } from './settings.js';
import { storage, STORES } from './storage.js';
import { NetworkMonitor } from './network-monitor.js';
import { LatencyMonitor } from './latency-monitor.js';
import { SpeedTestEngine } from './speed-test.js';
import { DiagnosticsEngine } from './diagnostics.js';
import { NetworkMapVisualizer } from './network-map.js';
import { AnalyticsEngine } from './analytics.js';
import { AlertsEngine } from './alerts.js';
import { drawLineChart } from './chart-renderer.js';
import {
  escapeHtml,
  formatDateTime,
  formatMbps,
  formatMs,
  formatTime,
  showToast,
  validateEndpointUrl
} from './utils.js';

const VIEW_META = {
  overview: {
    title: 'Live Network Overview',
    subtitle: 'Real-time browser telemetry, endpoint probes, and session stability'
  },
  speedtest: {
    title: 'Internet Speed Test',
    subtitle: 'Actual HTTP download/upload payload measurement and test history'
  },
  latency: {
    title: 'Latency & Stability Monitor',
    subtitle: 'Multi-endpoint HTTP response timing, RFC 3550 jitter, and incident timeline'
  },
  topology: {
    title: 'Network Map',
    subtitle: 'Interactive path visualization with explicit telemetry provenance'
  },
  diagnostics: {
    title: 'Network Diagnostics',
    subtitle: 'DNS-over-HTTPS resolution, HTTP availability, and troubleshooting'
  },
  analytics: {
    title: 'Network Analytics',
    subtitle: 'Historical performance trends, comparisons, and downloadable reports'
  },
  alerts: {
    title: 'Monitoring Alerts',
    subtitle: 'Configurable thresholds, alert feed, and browser notifications'
  },
  settings: {
    title: 'Platform Settings',
    subtitle: 'Polling cadence, Web Worker offloading, IndexedDB, and browser capabilities'
  }
};

class NetwatchApp {
  constructor() {
    this.settings = loadSettings();
    this.activeView = 'overview';
    this.monitoringActive = true;
    this.eventLog = [];
    this.prevOnline = navigator.onLine;
    this.lastSpeedResult = null;

    this.networkMonitor = new NetworkMonitor({
      onEvent: (lvl, msg) => this.logEvent(lvl, msg),
      onStatusChange: (snap) => this._renderStatusSnapshot(snap),
      onIncident: (_inc, list) => this._renderIncidents(list),
      onIpUpdate: (info) => this._renderIpInfo(info)
    });

    this.latencyMonitor = new LatencyMonitor({
      onSample: (payload) => this._handleLatencySample(payload),
      onEvent: (lvl, msg) => this.logEvent(lvl, msg),
      onFailureSpike: (sample) => {
        this.networkMonitor.recordIncident({
          type: 'probe_failure',
          severity: 'warn',
          title: `Probe Failed: ${sample.endpointName}`,
          detail: sample.error || 'Endpoint probe failed'
        });
        this.logEvent('warn', `Probe failed for ${sample.endpointName}: ${sample.error}`);
      },
      onIncident: (inc) => {
        this.networkMonitor.recordIncident(inc);
        this.logEvent(inc.severity, `${inc.title}: ${inc.detail}`);
      }
    });

    this.speedTest = new SpeedTestEngine({
      onProgress: (prog) => this._renderSpeedProgress(prog),
      onComplete: (res) => this._handleSpeedComplete(res),
      onError: (msg) => this._handleSpeedError(msg),
      onEvent: (lvl, msg) => this.logEvent(lvl, msg)
    });

    this.diagnostics = new DiagnosticsEngine();
    this.analytics = new AnalyticsEngine();
    this.alerts = new AlertsEngine({
      onEvent: (lvl, msg) => this.logEvent(lvl, msg),
      onBadgeUpdate: (count) => this._updateAlertBadge(count)
    });

    this.networkMap = null;
    this._gaugeArcLength = 0;
  }

  async init() {
    await storage.init();
    await this.alerts.loadHistory();

    this.networkMonitor.setPersistEnabled(this.settings.persistDb);
    this.speedTest.setPersistEnabled(this.settings.persistDb);
    this.analytics.setUseWorker(this.settings.useWorker);
    this.alerts.configure(this.settings.alerts, this.settings.persistDb);

    this.latencyMonitor.configure({
      endpoints: this.settings.endpoints,
      intervalMs: this.settings.pollIntervalMs,
      timeoutMs: this.settings.probeTimeoutMs,
      persistEnabled: this.settings.persistDb
    });

    this._initNavigation();
    this._initWidgetCustomizer();
    this._initSpeedometer();
    this._initSpeedTestUI();
    this._initLatencyUI();
    this._initTopologyUI();
    this._initDiagnosticsUI();
    this._initAnalyticsUI();
    this._initAlertsUI();
    this._initSettingsUI();
    this._initKeyboardShortcuts();

    // Load historical speed tests & incidents from IndexedDB
    await this._loadPersistedState();

    this.networkMonitor.start();
    this.latencyMonitor.start();

    if (this.settings.autoLookupIp) {
      this.networkMonitor.lookupPublicIp();
    } else {
      this._renderIpInfo({ ip: null, source: null, error: 'Auto-lookup disabled in Settings' });
    }

    this.logEvent('info', 'NETWATCH telemetry engine initialized.');
    window.addEventListener('beforeunload', () => this.destroy());
    window.addEventListener('resize', () => this._redrawActiveCharts());
  }

  destroy() {
    this.networkMonitor.stop();
    this.latencyMonitor.stop();
    this.speedTest.abort();
    if (this.networkMap) this.networkMap.setActive(false);
  }

  async _loadPersistedState() {
    const speeds = await storage.getAll(STORES.SPEEDS, 50);
    if (speeds.length > 0) {
      this.lastSpeedResult = speeds[speeds.length - 1];
      this._updateOverviewSpeedCards(this.lastSpeedResult, true);
    }
    this._renderSpeedHistory(speeds);

    const savedIncidents = await storage.getAll(STORES.INCIDENTS, 50);
    if (savedIncidents.length > 0) {
      this.networkMonitor.incidents = savedIncidents.reverse();
      this._renderIncidents(this.networkMonitor.incidents);
    }

    this.alerts.renderFeed(document.getElementById('alerts-feed'));
    this._renderCapabilities();
  }

  /* ---------------- Navigation & Shell ---------------- */
  _initNavigation() {
    const sidebar = document.getElementById('sidebar');
    const collapseBtn = document.getElementById('sidebar-collapse-btn');
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const backdrop = document.getElementById('sidebar-backdrop');

    if (this.settings.sidebarCollapsed) {
      sidebar.classList.add('is-collapsed');
      collapseBtn.setAttribute('aria-expanded', 'false');
    }

    collapseBtn.addEventListener('click', () => {
      const collapsed = sidebar.classList.toggle('is-collapsed');
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
      this.settings.sidebarCollapsed = collapsed;
      saveSettings(this.settings);
      window.setTimeout(() => this._redrawActiveCharts(), 260);
    });

    const closeMobileDrawer = () => {
      sidebar.classList.remove('is-open');
      backdrop.classList.remove('is-visible');
      mobileBtn.setAttribute('aria-expanded', 'false');
    };

    mobileBtn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('is-open');
      backdrop.classList.toggle('is-visible', open);
      mobileBtn.setAttribute('aria-expanded', String(open));
    });

    backdrop.addEventListener('click', closeMobileDrawer);

    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.switchView(btn.dataset.view);
        closeMobileDrawer();
      });
    });

    document.querySelectorAll('[data-nav-target]').forEach((btn) => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.navTarget));
    });

    document.getElementById('monitor-toggle-btn').addEventListener('click', () => this.toggleMonitoring());
    document.getElementById('quick-speedtest-btn').addEventListener('click', () => {
      this.switchView('speedtest');
    });
    document.getElementById('overview-probe-now-btn').addEventListener('click', () => {
      this.latencyMonitor.probeAll();
      showToast('Manual endpoint probe triggered.', 'info');
    });
    document.getElementById('clear-event-log-btn').addEventListener('click', () => {
      this.eventLog = [];
      this._renderEventLog();
    });
  }

  switchView(viewId) {
    if (!VIEW_META[viewId]) return;
    this.activeView = viewId;

    document.querySelectorAll('.view-panel').forEach((panel) => {
      const match = panel.id === `view-${viewId}`;
      panel.classList.toggle('is-active', match);
      panel.hidden = !match;
    });

    document.querySelectorAll('[data-view]').forEach((btn) => {
      const active = btn.dataset.view === viewId;
      btn.classList.toggle('is-active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });

    document.getElementById('view-title').textContent = VIEW_META[viewId].title;
    document.getElementById('view-subtitle').textContent = VIEW_META[viewId].subtitle;

    if (this.networkMap) {
      this.networkMap.setActive(viewId === 'topology');
    }

    if (viewId === 'alerts') {
      this.alerts.markRead();
      this.alerts.renderFeed(document.getElementById('alerts-feed'));
    }

    if (viewId === 'settings') {
      this._renderCapabilities();
    }

    this._redrawActiveCharts();
  }

  toggleMonitoring() {
    this.monitoringActive = !this.monitoringActive;
    const btn = document.getElementById('monitor-toggle-btn');
    const label = document.getElementById('monitor-toggle-label');

    if (this.monitoringActive) {
      this.latencyMonitor.start();
      label.textContent = 'Monitoring Active';
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');
      this.logEvent('info', 'Continuous endpoint monitoring resumed.');
    } else {
      this.latencyMonitor.stop();
      label.textContent = 'Monitoring Paused';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      this.logEvent('warn', 'Continuous endpoint monitoring paused.');
    }
  }

  /* ---------------- Widget Customizer ---------------- */
  _initWidgetCustomizer() {
    const toggleBtn = document.getElementById('customize-widgets-btn');
    const closeBtn = document.getElementById('close-customizer-btn');
    const drawer = document.getElementById('widget-customizer');
    const grid = document.getElementById('widget-toggles');

    const applyWidgets = () => {
      document.querySelectorAll('[data-widget]').forEach((el) => {
        const id = el.dataset.widget;
        const visible = this.settings.widgets[id] !== false;
        el.classList.toggle('hidden', !visible);
      });
    };

    grid.innerHTML = DEFAULT_WIDGETS.map((w) => {
      const checked = this.settings.widgets[w.id] !== false ? 'checked' : '';
      return `
        <label class="checkbox-row">
          <input type="checkbox" data-widget-toggle="${escapeHtml(w.id)}" ${checked} />
          <span>${escapeHtml(w.label)}</span>
        </label>
      `;
    }).join('');

    grid.addEventListener('change', (e) => {
      const id = e.target.dataset.widgetToggle;
      if (!id) return;
      this.settings.widgets[id] = e.target.checked;
      saveSettings(this.settings);
      applyWidgets();
      this._redrawActiveCharts();
    });

    toggleBtn.addEventListener('click', () => drawer.classList.toggle('hidden'));
    closeBtn.addEventListener('click', () => drawer.classList.add('hidden'));
    applyWidgets();
  }

  /* ---------------- Overview & Status Rendering ---------------- */
  _renderStatusSnapshot(snap) {
    const pill = document.getElementById('global-connection-pill');
    const pillText = document.getElementById('global-connection-text');
    const kpiStatus = document.getElementById('kpi-status-value');
    const kpiStatusMeta = document.getElementById('kpi-status-meta');
    const sidebarUptime = document.getElementById('sidebar-uptime');
    const kpiUptime = document.getElementById('kpi-uptime-value');
    const kpiUptimeMeta = document.getElementById('kpi-uptime-meta');
    const stabilityBadge = document.getElementById('stability-uptime-badge');

    if (snap.online !== this.prevOnline) {
      this.prevOnline = snap.online;
      this.alerts.evaluateConnectivity(snap.online);
    }

    const agg = this.latencyMonitor.getAggregateStats();
    const degraded = snap.online && agg.totalProbes >= 3 && agg.failureRatePct > 25;

    pill.className = 'status-pill ' + (
      !snap.online ? 'status-pill--offline' : degraded ? 'status-pill--degraded' : 'status-pill--online'
    );
    pillText.textContent = !snap.online ? 'OFFLINE' : degraded ? 'DEGRADED' : 'ONLINE';

    kpiStatus.textContent = !snap.online ? 'Offline' : degraded ? 'Degraded' : 'Connected';
    kpiStatusMeta.textContent = snap.online
      ? 'Browser navigator.onLine = true'
      : 'Browser reports no network connection';

    // Connection type from Navigator API
    const conn = snap.connection;
    const connValEl = document.getElementById('kpi-conntype-value');
    const connMetaEl = document.getElementById('kpi-conntype-meta');
    const connBadge = document.getElementById('badge-conntype');

    if (!conn.supported) {
      connValEl.textContent = 'Unavailable';
      connMetaEl.textContent = 'Navigator Connection API not exposed by browser';
      connBadge.className = 'badge badge--unavailable';
      connBadge.textContent = 'UNAVAILABLE';
    } else {
      const typeStr = [conn.type, conn.effectiveType].filter(Boolean).join(' / ') || 'Exposed';
      connValEl.textContent = typeStr.toUpperCase();
      const parts = [];
      if (conn.downlink !== null) parts.push(`Est. downlink ${conn.downlink} Mbps`);
      if (conn.rtt !== null) parts.push(`Est. RTT ${conn.rtt} ms`);
      if (conn.saveData) parts.push('Save-Data ON');
      connMetaEl.textContent = parts.join(' · ') || 'Navigator Connection API';
      connBadge.className = 'badge badge--estimated';
      connBadge.textContent = 'BROWSER API';
    }

    sidebarUptime.textContent = snap.uptime.elapsedFormatted;
    kpiUptime.textContent = `${snap.uptime.uptimePct.toFixed(1)}%`;
    kpiUptimeMeta.textContent = `Monitoring duration: ${snap.uptime.elapsedFormatted}`;
    if (stabilityBadge) {
      stabilityBadge.textContent = `${snap.uptime.uptimePct.toFixed(1)}% UPTIME`;
    }

    if (this.networkMap && this.activeView === 'topology') {
      this._syncTopology();
    }
  }

  _renderIpInfo(info) {
    const val = document.getElementById('kpi-ip-value');
    const meta = document.getElementById('kpi-ip-meta');
    const badge = document.getElementById('badge-ip');

    if (info.ip) {
      val.textContent = info.ip;
      meta.textContent = info.colo ? `Source: ${info.source} (PoP ${info.colo})` : `Source: ${info.source}`;
      badge.className = 'badge badge--actual';
      badge.textContent = 'ACTUAL';
    } else {
      val.textContent = 'Unavailable';
      meta.textContent = info.error || 'Public IP lookup failed';
      badge.className = 'badge badge--unavailable';
      badge.textContent = 'UNAVAILABLE';
    }
  }

  _handleLatencySample({ results, aggregate, samples }) {
    const latEl = document.getElementById('kpi-latency-value');
    const latMeta = document.getElementById('kpi-latency-meta');
    const latBadge = document.getElementById('badge-latency');

    const jitEl = document.getElementById('kpi-jitter-value');
    const jitMeta = document.getElementById('kpi-jitter-meta');
    const jitBadge = document.getElementById('badge-jitter');

    const lossEl = document.getElementById('kpi-loss-value');

    if (aggregate.latestRtt !== null) {
      latEl.textContent = formatMs(aggregate.latestRtt);
      latMeta.textContent = `Endpoint: ${aggregate.latestEndpoint} (Avg ${formatMs(aggregate.avg)})`;
      latBadge.className = 'badge badge--actual';
      latBadge.textContent = 'ACTUAL';
    } else {
      latEl.textContent = 'Unavailable';
      latMeta.textContent = 'No reachable endpoint responses yet';
      latBadge.className = 'badge badge--unavailable';
      latBadge.textContent = 'UNAVAILABLE';
    }

    if (aggregate.jitter !== null) {
      jitEl.textContent = formatMs(aggregate.jitter);
      jitMeta.textContent = 'Computed from consecutive HTTP RTT deltas';
      jitBadge.className = 'badge badge--estimated';
      jitBadge.textContent = 'ESTIMATED';
    } else {
      jitEl.textContent = '—';
      jitMeta.textContent = 'Requires >= 2 successful samples';
    }

    lossEl.textContent = `${aggregate.failureRatePct.toFixed(1)}%`;

    document.getElementById('overview-active-endpoint').textContent =
      aggregate.latestEndpoint || `${results.length} targets`;

    // Latency view stats strip
    document.getElementById('lat-min').textContent = formatMs(aggregate.min);
    document.getElementById('lat-avg').textContent = formatMs(aggregate.avg);
    document.getElementById('lat-max').textContent = formatMs(aggregate.max);
    document.getElementById('lat-jitter').textContent = formatMs(aggregate.jitter);
    document.getElementById('lat-fails').textContent = String(aggregate.failedProbes);

    this._renderEndpointLists();
    this.alerts.evaluateSample({ results, aggregate });

    if (this.activeView === 'overview' || this.activeView === 'latency') {
      this._drawLatencyCharts(samples);
    }
    if (this.activeView === 'topology') {
      this._syncTopology();
    }
    if (this.activeView === 'analytics') {
      this.analytics.refresh(this.latencyMonitor.samples, this.networkMonitor.incidents);
    }
  }

  _drawLatencyCharts(samples) {
    const recent = samples.slice(-120);
    const byEndpoint = new Map();
    const palette = ['#00E5FF', '#8B5CF6', '#10B981', '#F59E0B'];

    for (const s of recent) {
      if (!byEndpoint.has(s.endpointId)) {
        byEndpoint.set(s.endpointId, { label: s.endpointName, data: [] });
      }
      byEndpoint.get(s.endpointId).data.push({ t: s.timestamp, y: s.ok ? s.rttMs : null });
    }

    const series = Array.from(byEndpoint.values()).map((s, idx) => ({
      ...s,
      color: palette[idx % palette.length]
    }));

    const hasOk = recent.some((s) => s.ok);
    const overviewEmpty = document.getElementById('overview-chart-empty');
    const latencyEmpty = document.getElementById('latency-chart-empty');
    if (overviewEmpty) overviewEmpty.classList.toggle('hidden', hasOk);
    if (latencyEmpty) latencyEmpty.classList.toggle('hidden', hasOk);

    if (this.activeView === 'overview') {
      drawLineChart(document.getElementById('overview-latency-canvas'), series, { unit: 'ms', minZero: true });
    }
    if (this.activeView === 'latency') {
      drawLineChart(document.getElementById('latency-history-canvas'), series, { unit: 'ms', minZero: true });
    }
  }

  _renderEndpointLists() {
    const summaries = this.latencyMonitor.getEndpointSummaries();

    const overviewList = document.getElementById('overview-endpoints-list');
    if (overviewList) {
      overviewList.innerHTML = summaries.map((ep) => {
        const last = ep.lastSample;
        const badge = !ep.enabled
          ? '<span class="badge badge--unavailable">DISABLED</span>'
          : !last
            ? '<span class="badge badge--unavailable">PENDING</span>'
            : last.ok
              ? `<span class="badge badge--actual">${formatMs(last.rttMs)}</span>`
              : `<span class="badge badge--error">FAIL</span>`;
        return `
          <div class="endpoint-row">
            <div class="endpoint-info">
              <div class="endpoint-name">${escapeHtml(ep.name)}</div>
              <div class="endpoint-url">${escapeHtml(ep.url)}</div>
            </div>
            <div class="endpoint-metrics">${badge}</div>
          </div>
        `;
      }).join('');
    }

    const managerList = document.getElementById('endpoint-manager-list');
    if (managerList) {
      managerList.innerHTML = summaries.map((ep) => {
        const last = ep.lastSample;
        const statusText = !ep.enabled
          ? 'Paused'
          : last
            ? (last.ok ? formatMs(last.rttMs) : (last.error || 'Failed'))
            : 'Pending';
        return `
          <div class="endpoint-row">
            <div class="endpoint-info">
              <div class="endpoint-name">${escapeHtml(ep.name)}</div>
              <div class="endpoint-url">${escapeHtml(ep.url)}</div>
            </div>
            <div class="endpoint-metrics">
              <span class="mono-val" style="font-size:12px;">${escapeHtml(statusText)}</span>
              <button class="btn btn-ghost btn-xs" data-ep-toggle="${escapeHtml(ep.id)}" type="button">${ep.enabled ? 'Disable' : 'Enable'}</button>
              <button class="btn btn-danger btn-xs" data-ep-delete="${escapeHtml(ep.id)}" type="button" aria-label="Remove ${escapeHtml(ep.name)}">&times;</button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  _renderIncidents(list) {
    const el = document.getElementById('incident-timeline');
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="empty-state">No network incidents detected during this session.</div>';
      return;
    }

    el.innerHTML = list.slice(0, 40).map((inc) => {
      const badgeClass = inc.severity === 'error' ? 'badge--error' : inc.severity === 'warn' ? 'badge--warn' : 'badge--actual';
      return `
        <div class="timeline-item">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:3px;">
            <strong>${escapeHtml(inc.title)}</strong>
            <span class="badge ${badgeClass}">${escapeHtml(inc.type)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(inc.detail)}</div>
          <div class="event-time" style="margin-top:4px;">${escapeHtml(formatDateTime(inc.timestamp))}</div>
        </div>
      `;
    }).join('');
  }

  logEvent(level, message) {
    this.eventLog.unshift({ timestamp: Date.now(), level, message });
    if (this.eventLog.length > 100) this.eventLog.pop();
    this._renderEventLog();
  }

  _renderEventLog() {
    const container = document.getElementById('live-event-log');
    if (!container) return;
    if (this.eventLog.length === 0) {
      container.innerHTML = '<div class="empty-state">No events logged yet.</div>';
      return;
    }

    container.innerHTML = this.eventLog.slice(0, 50).map((ev) => `
      <div class="event-item event-item--${escapeHtml(ev.level)}">
        <span class="event-time">${escapeHtml(formatTime(ev.timestamp))}</span>
        <span class="badge badge--${ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : ev.level === 'ok' ? 'actual' : 'unavailable'}">${escapeHtml(ev.level)}</span>
        <span>${escapeHtml(ev.message)}</span>
      </div>
    `).join('');
  }

  /* ---------------- Speed Test UI ---------------- */
  _initSpeedometer() {
    const arc = document.getElementById('gauge-arc');
    if (arc) {
      this._gaugeArcLength = arc.getTotalLength();
      arc.style.strokeDasharray = String(this._gaugeArcLength);
      arc.style.strokeDashoffset = String(this._gaugeArcLength);
    }

    const ticksGroup = document.getElementById('gauge-ticks');
    if (ticksGroup) {
      const cx = 160;
      const cy = 155;
      const rOuter = 136;
      const rInner = 128;
      let svg = '';
      for (let i = 0; i <= 10; i += 1) {
        const deg = -215 + (i / 10) * 250;
        const rad = (deg * Math.PI) / 180;
        const x1 = cx + Math.cos(rad) * rInner;
        const y1 = cy + Math.sin(rad) * rInner;
        const x2 = cx + Math.cos(rad) * rOuter;
        const y2 = cy + Math.sin(rad) * rOuter;
        svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#475569" stroke-width="1.5" />`;
      }
      ticksGroup.innerHTML = svg;
    }
  }

  _updateGauge(mbps, phaseLabel) {
    const clamped = Math.max(0, mbps || 0);
    // Log-like visual scale up to 500 Mbps
    const norm = Math.min(1, Math.log10(1 + clamped) / Math.log10(501));
    const angle = -125 + norm * 250;

    const needle = document.getElementById('gauge-needle');
    const arc = document.getElementById('gauge-arc');
    const valEl = document.getElementById('gauge-value');
    const phaseEl = document.getElementById('gauge-phase');

    if (needle) needle.setAttribute('transform', `rotate(${angle.toFixed(1)} 160 155)`);
    if (arc && this._gaugeArcLength) {
      arc.style.strokeDashoffset = String(this._gaugeArcLength * (1 - norm));
    }
    if (valEl) valEl.textContent = clamped.toFixed(2);
    if (phaseEl) phaseEl.textContent = phaseLabel;
  }

  _initSpeedTestUI() {
    const providerSel = document.getElementById('st-provider-select');
    const customFields = document.getElementById('st-custom-fields');
    const downUrlInput = document.getElementById('st-down-url');
    const upUrlInput = document.getElementById('st-up-url');
    const downSizeSel = document.getElementById('st-down-size');
    const upSizeSel = document.getElementById('st-up-size');
    const startBtn = document.getElementById('speedtest-start-btn');
    const stopBtn = document.getElementById('speedtest-stop-btn');

    providerSel.value = this.settings.speedTest.provider;
    downUrlInput.value = this.settings.speedTest.customDownUrl;
    upUrlInput.value = this.settings.speedTest.customUpUrl;
    downSizeSel.value = String(this.settings.speedTest.downBytes);
    upSizeSel.value = String(this.settings.speedTest.upBytes);
    customFields.classList.toggle('hidden', providerSel.value !== 'custom');

    const syncConfig = () => {
      this.settings.speedTest = {
        ...this.settings.speedTest,
        provider: providerSel.value,
        customDownUrl: downUrlInput.value.trim(),
        customUpUrl: upUrlInput.value.trim(),
        downBytes: Number(downSizeSel.value) || 3000000,
        upBytes: Number(upSizeSel.value) || 1000000
      };
      customFields.classList.toggle('hidden', providerSel.value !== 'custom');
      saveSettings(this.settings);
    };

    document.getElementById('speedtest-config-form').addEventListener('submit', (e) => e.preventDefault());

    providerSel.addEventListener('change', syncConfig);
    downUrlInput.addEventListener('change', syncConfig);
    upUrlInput.addEventListener('change', syncConfig);
    downSizeSel.addEventListener('change', syncConfig);
    upSizeSel.addEventListener('change', syncConfig);

    startBtn.addEventListener('click', () => {
      syncConfig();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      this.speedTest.run(this.settings.speedTest);
    });

    stopBtn.addEventListener('click', () => {
      this.speedTest.abort();
      startBtn.disabled = false;
      stopBtn.disabled = true;
    });

    document.getElementById('clear-speed-history-btn').addEventListener('click', async () => {
      await storage.clearStore(STORES.SPEEDS);
      this._renderSpeedHistory([]);
      showToast('Speed test history cleared.', 'info');
    });
  }

  _renderSpeedProgress(prog) {
    this._updateGauge(prog.speedMbps || 0, prog.phase);

    document.getElementById('speedtest-status-text').textContent = prog.status;
    document.getElementById('speedtest-progress-pct').textContent = `${prog.pct}%`;
    document.getElementById('speedtest-progress-fill').style.width = `${prog.pct}%`;
    document.getElementById('speedtest-progressbar').setAttribute('aria-valuenow', String(prog.pct));

    if (prog.downloadMbps !== undefined) {
      document.getElementById('st-download-val').textContent = formatMbps(prog.downloadMbps);
    }
    if (prog.uploadMbps !== undefined) {
      document.getElementById('st-upload-val').textContent = formatMbps(prog.uploadMbps);
    }
    if (prog.latencyMs !== undefined) {
      document.getElementById('st-latency-val').textContent = formatMs(prog.latencyMs);
    }
    if (prog.jitterMs !== undefined) {
      document.getElementById('st-jitter-val').textContent = formatMs(prog.jitterMs);
    }

    if (prog.phase === 'ABORTED') {
      document.getElementById('speedtest-start-btn').disabled = false;
      document.getElementById('speedtest-stop-btn').disabled = true;
    }
  }

  async _handleSpeedComplete(res) {
    document.getElementById('speedtest-start-btn').disabled = false;
    document.getElementById('speedtest-stop-btn').disabled = true;
    this.lastSpeedResult = res;
    this._updateOverviewSpeedCards(res, false);
    const all = await storage.getAll(STORES.SPEEDS, 50);
    this._renderSpeedHistory(all);
    showToast(`Speed test complete: ↓ ${res.downloadMbps.toFixed(2)} Mbps`, 'ok');
  }

  _handleSpeedError(msg) {
    document.getElementById('speedtest-start-btn').disabled = false;
    document.getElementById('speedtest-stop-btn').disabled = true;
    this._updateGauge(0, 'ERROR');
    document.getElementById('speedtest-status-text').textContent = msg;
    showToast(msg, 'error');
  }

  _updateOverviewSpeedCards(res, fromHistory) {
    const dlVal = document.getElementById('kpi-download-value');
    const dlMeta = document.getElementById('kpi-download-meta');
    const dlBadge = document.getElementById('badge-download');

    const ulVal = document.getElementById('kpi-upload-value');
    const ulMeta = document.getElementById('kpi-upload-meta');
    const ulBadge = document.getElementById('badge-upload');

    dlVal.textContent = formatMbps(res.downloadMbps);
    dlMeta.textContent = `${fromHistory ? 'Last recorded' : 'Measured'}: ${formatDateTime(res.timestamp)}`;
    dlBadge.className = 'badge badge--actual';
    dlBadge.textContent = 'ACTUAL';

    ulVal.textContent = formatMbps(res.uploadMbps);
    ulMeta.textContent = `${fromHistory ? 'Last recorded' : 'Measured'}: ${formatDateTime(res.timestamp)}`;
    ulBadge.className = 'badge badge--actual';
    ulBadge.textContent = 'ACTUAL';
  }

  _renderSpeedHistory(list) {
    const wrap = document.getElementById('speedtest-history-list');
    if (!wrap) return;
    if (!list || list.length === 0) {
      wrap.innerHTML = '<div class="empty-state">No speed tests recorded yet.</div>';
      return;
    }

    const rows = [...list].reverse().slice(0, 20).map((r) => `
      <tr>
        <td class="mono-val">${escapeHtml(formatDateTime(r.timestamp))}</td>
        <td class="mono-val">${r.downloadMbps.toFixed(2)} Mbps</td>
        <td class="mono-val">${r.uploadMbps.toFixed(2)} Mbps</td>
        <td class="mono-val">${r.latencyMs.toFixed(1)} ms</td>
        <td class="mono-val">${r.jitterMs !== null ? r.jitterMs.toFixed(1) + ' ms' : '—'}</td>
      </tr>
    `).join('');

    wrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Time</th><th>Download</th><th>Upload</th><th>Latency</th><th>Jitter</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /* ---------------- Latency & Endpoints UI ---------------- */
  _initLatencyUI() {
    const intervalSel = document.getElementById('latency-interval-select');
    intervalSel.value = String(this.settings.pollIntervalMs);
    intervalSel.addEventListener('change', () => {
      this.settings.pollIntervalMs = Number(intervalSel.value);
      saveSettings(this.settings);
      this.latencyMonitor.configure({ intervalMs: this.settings.pollIntervalMs });
      document.getElementById('setting-poll-interval').value = String(this.settings.pollIntervalMs);
      showToast(`Probe interval updated to ${this.settings.pollIntervalMs / 1000}s`, 'info');
    });

    document.getElementById('latency-sample-btn').addEventListener('click', () => {
      this.latencyMonitor.probeAll();
    });

    document.getElementById('add-endpoint-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('new-endpoint-name');
      const urlInput = document.getElementById('new-endpoint-url');
      const name = nameInput.value.trim();
      const check = validateEndpointUrl(urlInput.value);

      if (!name) {
        showToast('Provide an endpoint label.', 'error');
        return;
      }
      if (!check.valid) {
        showToast(check.error, 'error');
        return;
      }

      this.settings.endpoints.push({
        id: `ep-${Date.now().toString(36)}`,
        name,
        url: check.url,
        mode: 'cors',
        enabled: true
      });
      saveSettings(this.settings);
      this.latencyMonitor.configure({ endpoints: this.settings.endpoints });
      this._renderEndpointLists();
      nameInput.value = '';
      urlInput.value = '';
      this.latencyMonitor.probeAll();
      showToast(`Added endpoint ${name}`, 'ok');
    });

    document.getElementById('endpoint-manager-list').addEventListener('click', (e) => {
      const toggleId = e.target.dataset.epToggle;
      const deleteId = e.target.dataset.epDelete;

      if (toggleId) {
        const ep = this.settings.endpoints.find((x) => x.id === toggleId);
        if (ep) {
          ep.enabled = !ep.enabled;
          saveSettings(this.settings);
          this.latencyMonitor.configure({ endpoints: this.settings.endpoints });
          this._renderEndpointLists();
        }
      } else if (deleteId) {
        if (this.settings.endpoints.length <= 1) {
          showToast('At least one endpoint must remain configured.', 'warn');
          return;
        }
        this.settings.endpoints = this.settings.endpoints.filter((x) => x.id !== deleteId);
        saveSettings(this.settings);
        this.latencyMonitor.configure({ endpoints: this.settings.endpoints });
        this._renderEndpointLists();
      }
    });

    this._renderEndpointLists();
  }

  /* ---------------- Topology UI ---------------- */
  _initTopologyUI() {
    const canvas    = document.getElementById('network-map-canvas');
    const inspector = document.getElementById('topology-node-details');
    this.networkMap = new NetworkMapVisualizer(canvas, inspector);

    // Hook scan status updates
    this.networkMap.onScanStatusChange = (evt) => this._handleScanStatus(evt);

    document.getElementById('topology-reset-btn').addEventListener('click', () => {
      this.networkMap.resetView();
    });

    document.getElementById('topology-scan-btn').addEventListener('click', () => {
      this.networkMap.scanNetwork();
    });
  }

  _handleScanStatus({ status, count, scannedAt, message }) {
    const badge      = document.getElementById('topology-agent-badge');
    const countBadge = document.getElementById('topology-device-count');
    const notice     = document.getElementById('topology-scan-status');
    const scanBtn    = document.getElementById('topology-scan-btn');
    const lastScanEl = document.getElementById('topology-last-scan');

    switch (status) {
      case 'idle':
        badge.textContent = 'Agent Online';
        badge.className   = 'badge badge--actual';
        notice.textContent = 'Agent connected — click Scan Network to discover devices.';
        scanBtn.disabled  = false;
        break;

      case 'scanning':
        badge.textContent  = 'Scanning…';
        badge.className    = 'badge badge--warn';
        notice.textContent = 'ARP/ping sweep in progress — this takes 20–40 s…';
        scanBtn.disabled   = true;
        break;

      case 'done': {
        badge.textContent  = 'Agent Online';
        badge.className    = 'badge badge--actual';
        countBadge.textContent = `${count} Device${count !== 1 ? 's' : ''}`;
        countBadge.style.display = '';
        notice.textContent = `Scan complete — ${count} device${count !== 1 ? 's' : ''} found.`;
        scanBtn.disabled   = false;
        if (scannedAt && lastScanEl) {
          lastScanEl.textContent = `Last scan: ${new Date(scannedAt).toLocaleTimeString()}`;
        }
        this._renderDeviceList(this.networkMap.lanDevices);
        this.logEvent('ok', `LAN scan complete: ${count} device${count !== 1 ? 's' : ''} discovered.`);
        break;
      }

      case 'unavailable':
        badge.textContent  = 'Agent Offline';
        badge.className    = 'badge badge--unavailable';
        notice.textContent = 'Agent unavailable — run: node agent.js in the NETWATCH folder.';
        scanBtn.disabled   = false;
        break;

      case 'error':
        badge.textContent  = 'Scan Error';
        badge.className    = 'badge badge--error';
        notice.textContent = `Scan failed: ${message || 'Unknown error'}`;
        scanBtn.disabled   = false;
        this.logEvent('error', `LAN scan failed: ${message}`);
        break;
    }
  }

  _renderDeviceList(devices) {
    const el = document.getElementById('topology-device-list');
    if (!el) return;
    if (!devices || devices.length === 0) {
      el.innerHTML = '<div class="empty-state" style="font-size:12px;">No devices discovered.</div>';
      return;
    }

    const TYPE_ICON = {
      'this-device': '💻', 'router': '📡', 'desktop': '🖥',
      'phone': '📱', 'server': '🖧', 'iot': '🔌', 'unknown': '❓'
    };

    el.innerHTML = devices.map((d) => {
      const icon = TYPE_ICON[d.type] || '❓';
      const label = d.hostname || d.ip;
      const sub   = d.vendor !== 'Unknown' ? d.vendor : d.ip;
      const statusColor = d.status === 'online' ? '#16a34a' : '#dc2626';
      return `
        <div class="cap-item" style="cursor:pointer;padding:6px 4px;border-radius:6px;" data-device-ip="${escapeHtml(d.ip)}">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:18px;">${icon}</span>
            <div>
              <div style="font-size:12px;font-weight:600;color:#f3f4f6;">${escapeHtml(label)}</div>
              <div style="font-size:11px;color:#9ca3af;">${escapeHtml(sub)}</div>
            </div>
            <span style="margin-left:auto;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
          </div>
        </div>
      `;
    }).join('');

    // Click on device list item → select node on canvas
    el.addEventListener('click', (e) => {
      const item = e.target.closest('[data-device-ip]');
      if (!item) return;
      const ip = item.dataset.deviceIp;
      const nodeId = `lan-${ip.replace(/\./g, '-')}`;
      const node = this.networkMap.nodes.find((n) => n.id === nodeId);
      if (node) {
        this.networkMap.selectedNodeId = nodeId;
        this.networkMap._renderInspector(node);
      }
    });
  }

  _syncTopology() {
    if (!this.networkMap) return;
    const snap = this.networkMonitor.getStatusSnapshot();
    const connType = snap.connection.supported
      ? [snap.connection.type, snap.connection.effectiveType].filter(Boolean).join(' / ')
      : null;

    this.networkMap.updateTelemetry({
      online: snap.online,
      publicIp: snap.publicIp,
      connType,
      endpoints: this.latencyMonitor.getEndpointSummaries()
    });
  }

  /* ---------------- Diagnostics UI ---------------- */
  _initDiagnosticsUI() {
    const runSuite = async () => {
      const resEl = document.getElementById('diagnostics-results');
      const recEl = document.getElementById('diagnostics-recommendations');
      resEl.innerHTML = '<div class="empty-state">Running live diagnostics...</div>';

      const domain = document.getElementById('diag-domain-input').value;
      const recordType = document.getElementById('diag-record-type').value;
      const url = document.getElementById('diag-url-input').value;

      const { results, recommendations } = await this.diagnostics.runFullSuite({
        domain,
        recordType,
        url,
        networkMonitor: this.networkMonitor
      });

      this._renderDiagnostics(results, recommendations, resEl, recEl);
    };

    document.getElementById('diagnostics-form').addEventListener('submit', (e) => {
      e.preventDefault();
      runSuite();
    });

    document.getElementById('run-all-diagnostics-btn').addEventListener('click', runSuite);

    document.getElementById('run-dns-btn').addEventListener('click', async () => {
      const domain = document.getElementById('diag-domain-input').value;
      const recordType = document.getElementById('diag-record-type').value;
      const r = await this.diagnostics.resolveDns(domain, recordType);
      const recs = this.diagnostics.buildRecommendations([r], this.networkMonitor.getStatusSnapshot());
      this._renderDiagnostics([r], recs, document.getElementById('diagnostics-results'), document.getElementById('diagnostics-recommendations'));
    });

    document.getElementById('run-http-check-btn').addEventListener('click', async () => {
      const url = document.getElementById('diag-url-input').value;
      const r = await this.diagnostics.checkHttpEndpoint(url);
      const recs = this.diagnostics.buildRecommendations([r], this.networkMonitor.getStatusSnapshot());
      this._renderDiagnostics([r], recs, document.getElementById('diagnostics-results'), document.getElementById('diagnostics-recommendations'));
    });
  }

  _renderDiagnostics(results, recommendations, resEl, recEl) {
    resEl.innerHTML = results.map((r) => {
      const badgeClass = r.ok ? 'badge--actual' : 'badge--error';
      const detailParts = [];
      if (r.summary) detailParts.push(r.summary);
      if (r.resolver) detailParts.push(`Resolver: ${r.resolver}`);
      if (r.statusText) detailParts.push(`HTTP: ${r.status || ''} ${r.statusText}`);
      if (r.rttMs !== undefined) detailParts.push(`Time: ${r.rttMs.toFixed(1)} ms`);
      if (r.records && r.records.length > 0) {
        detailParts.push(`Records: ${r.records.map((rec) => `${rec.data} (TTL ${rec.ttl}s)`).join(', ')}`);
      }
      if (r.error) detailParts.push(`Error: ${r.error}`);

      return `
        <div class="diag-item">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
            <strong>${escapeHtml(r.name)}</strong>
            <span class="badge ${badgeClass}">${r.ok ? 'PASS' : 'FAIL'}</span>
          </div>
          <div class="mono-val" style="font-size:12px;color:var(--text-muted);word-break:break-word;">${escapeHtml(detailParts.join(' · '))}</div>
        </div>
      `;
    }).join('');

    recEl.innerHTML = recommendations.map((rec) => {
      const badgeClass = rec.severity === 'error' ? 'badge--error' : rec.severity === 'warn' ? 'badge--warn' : rec.severity === 'ok' ? 'badge--actual' : 'badge--estimated';
      return `
        <div class="rec-item">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">
            <strong>${escapeHtml(rec.title)}</strong>
            <span class="badge ${badgeClass}">${escapeHtml(rec.severity)}</span>
          </div>
          <div style="font-size:12.5px;color:var(--text-muted);">${escapeHtml(rec.detail)}</div>
        </div>
      `;
    }).join('');
  }

  /* ---------------- Analytics UI ---------------- */
  _initAnalyticsUI() {
    document.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this.analytics.setRange(btn.dataset.range);
        this.analytics.refresh(this.latencyMonitor.samples, this.networkMonitor.incidents);
      });
    });

    document.getElementById('export-csv-btn').addEventListener('click', () => {
      this.analytics.exportReport('csv', this.latencyMonitor.samples, this.networkMonitor.incidents);
      showToast('Exported CSV telemetry.', 'ok');
    });
    document.getElementById('export-json-btn').addEventListener('click', () => {
      this.analytics.exportReport('json', this.latencyMonitor.samples, this.networkMonitor.incidents);
      showToast('Exported JSON telemetry.', 'ok');
    });
    document.getElementById('export-report-btn').addEventListener('click', () => {
      this.analytics.exportReport('html', this.latencyMonitor.samples, this.networkMonitor.incidents);
      showToast('Downloaded HTML performance report.', 'ok');
    });
  }

  /* ---------------- Alerts UI ---------------- */
  _initAlertsUI() {
    const latInput = document.getElementById('alert-latency-max');
    const jitInput = document.getElementById('alert-jitter-max');
    const lossInput = document.getElementById('alert-loss-max');
    const coolInput = document.getElementById('alert-cooldown-sec');
    const discCheck = document.getElementById('alert-notify-disconnect');
    const browCheck = document.getElementById('alert-notify-browser');

    const syncInputs = () => {
      latInput.value = String(this.settings.alerts.latencyMaxMs);
      jitInput.value = String(this.settings.alerts.jitterMaxMs);
      lossInput.value = String(this.settings.alerts.failureRateMaxPct);
      coolInput.value = String(this.settings.alerts.cooldownSec);
      discCheck.checked = this.settings.alerts.notifyDisconnect;
      browCheck.checked = this.settings.alerts.notifyBrowser;
    };
    syncInputs();

    document.getElementById('alert-thresholds-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.settings.alerts = {
        latencyMaxMs: Math.max(20, Number(latInput.value) || 200),
        jitterMaxMs: Math.max(5, Number(jitInput.value) || 50),
        failureRateMaxPct: Math.max(1, Math.min(100, Number(lossInput.value) || 20)),
        cooldownSec: Math.max(5, Number(coolInput.value) || 30),
        notifyDisconnect: discCheck.checked,
        notifyBrowser: browCheck.checked
      };
      saveSettings(this.settings);
      this.alerts.configure(this.settings.alerts, this.settings.persistDb);
      showToast('Alert rules saved.', 'ok');
    });

    document.getElementById('request-notif-btn').addEventListener('click', async () => {
      const res = await this.alerts.requestNotificationPermission();
      if (!res.supported) {
        showToast('Web Notifications API not supported in this browser.', 'warn');
      } else if (res.permission === 'granted') {
        browCheck.checked = true;
        this.settings.alerts.notifyBrowser = true;
        saveSettings(this.settings);
        this.alerts.configure(this.settings.alerts, this.settings.persistDb);
        showToast('Browser notifications enabled.', 'ok');
      } else {
        showToast(`Notification permission: ${res.permission}`, 'warn');
      }
    });

    document.getElementById('clear-alerts-btn').addEventListener('click', async () => {
      await this.alerts.clearAll();
      this.alerts.renderFeed(document.getElementById('alerts-feed'));
      showToast('Alert feed cleared.', 'info');
    });
  }

  _updateAlertBadge(count) {
    const badge = document.getElementById('sidebar-alert-badge');
    if (!badge) return;
    badge.textContent = String(count);
    badge.classList.toggle('hidden', count <= 0);
  }

  /* ---------------- Settings & Capabilities ---------------- */
  _initSettingsUI() {
    const pollInput = document.getElementById('setting-poll-interval');
    const timeoutInput = document.getElementById('setting-timeout');
    const workerCheck = document.getElementById('setting-use-worker');
    const persistCheck = document.getElementById('setting-persist-db');
    const ipCheck = document.getElementById('setting-auto-ip');

    const loadForm = () => {
      pollInput.value = String(this.settings.pollIntervalMs);
      timeoutInput.value = String(this.settings.probeTimeoutMs);
      workerCheck.checked = this.settings.useWorker;
      persistCheck.checked = this.settings.persistDb;
      ipCheck.checked = this.settings.autoLookupIp;
    };
    loadForm();

    document.getElementById('settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.settings.pollIntervalMs = Math.max(2000, Number(pollInput.value) || 5000);
      this.settings.probeTimeoutMs = Math.max(1000, Number(timeoutInput.value) || 4500);
      this.settings.useWorker = workerCheck.checked;
      this.settings.persistDb = persistCheck.checked;
      this.settings.autoLookupIp = ipCheck.checked;
      saveSettings(this.settings);

      this.latencyMonitor.configure({
        intervalMs: this.settings.pollIntervalMs,
        timeoutMs: this.settings.probeTimeoutMs,
        persistEnabled: this.settings.persistDb
      });
      this.networkMonitor.setPersistEnabled(this.settings.persistDb);
      this.speedTest.setPersistEnabled(this.settings.persistDb);
      this.analytics.setUseWorker(this.settings.useWorker);
      this.alerts.configure(this.settings.alerts, this.settings.persistDb);

      showToast('Platform settings applied.', 'ok');
      this._renderCapabilities();
    });

    document.getElementById('reset-settings-btn').addEventListener('click', () => {
      this.settings = resetSettings();
      loadForm();
      this.latencyMonitor.configure({
        endpoints: this.settings.endpoints,
        intervalMs: this.settings.pollIntervalMs,
        timeoutMs: this.settings.probeTimeoutMs,
        persistEnabled: this.settings.persistDb
      });
      this._renderEndpointLists();
      showToast('Settings restored to defaults.', 'info');
    });

    document.getElementById('purge-db-btn').addEventListener('click', async () => {
      await storage.purgeAll();
      this._renderSpeedHistory([]);
      this.alerts.alerts = [];
      this.alerts.renderFeed(document.getElementById('alerts-feed'));
      this._renderCapabilities();
      showToast('Local IndexedDB history purged.', 'warn');
    });
  }

  async _renderCapabilities() {
    const el = document.getElementById('capabilities-summary');
    if (!el) return;
    const counts = await storage.getCounts();
    const caps = [
      { label: 'Fetch & Performance Timing API', value: typeof fetch === 'function' ? 'Supported (HTTP RTT)' : 'Unavailable' },
      { label: 'Navigator NetworkInformation API', value: (navigator.connection || navigator.mozConnection) ? 'Supported (Estimated)' : 'Not exposed by browser' },
      { label: 'Web Workers', value: typeof Worker !== 'undefined' ? (this.settings.useWorker ? 'Enabled & Active' : 'Disabled in Settings') : 'Unsupported' },
      { label: 'IndexedDB Persistence', value: storage.available ? `Active (${counts.SAMPLES || 0} samples, ${counts.SPEEDS || 0} speed tests)` : 'Unavailable' },
      { label: 'Raw ICMP Ping / Router ARP / Packet Capture', value: 'Unavailable (Browser security sandbox)' }
    ];

    el.innerHTML = caps.map((c) => `
      <div class="cap-item">
        <div class="muted-label">${escapeHtml(c.label)}</div>
        <div class="mono-val" style="font-size:12.5px;">${escapeHtml(c.value)}</div>
      </div>
    `).join('');
  }

  /* ---------------- Keyboard Shortcuts & Chart Redraw ---------------- */
  _initKeyboardShortcuts() {
    const dialog = document.getElementById('shortcuts-dialog');
    document.getElementById('shortcuts-btn').addEventListener('click', () => dialog.showModal());
    document.getElementById('close-shortcuts-btn').addEventListener('click', () => dialog.close());

    const viewKeys = ['overview', 'speedtest', 'latency', 'topology', 'diagnostics', 'analytics', 'alerts', 'settings'];

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key >= '1' && e.key <= '8') {
        this.switchView(viewKeys[Number(e.key) - 1]);
      } else if (e.key === '[') {
        document.getElementById('sidebar-collapse-btn').click();
      } else if (e.key === ' ') {
        e.preventDefault();
        this.toggleMonitoring();
      } else if (e.key.toLowerCase() === 'r') {
        this.latencyMonitor.probeAll();
        showToast('Probe triggered.', 'info');
      } else if (e.key.toLowerCase() === 's') {
        this.switchView('speedtest');
      } else if (e.key === '?') {
        if (dialog.open) dialog.close();
        else dialog.showModal();
      } else if (e.key === 'Escape' && dialog.open) {
        dialog.close();
      }
    });
  }

  _redrawActiveCharts() {
    if (this.activeView === 'overview' || this.activeView === 'latency') {
      this._drawLatencyCharts(this.latencyMonitor.samples);
    } else if (this.activeView === 'topology') {
      this._syncTopology();
    } else if (this.activeView === 'analytics') {
      this.analytics.refresh(this.latencyMonitor.samples, this.networkMonitor.incidents);
    }
  }
}

const app = new NetwatchApp();
app.init();
