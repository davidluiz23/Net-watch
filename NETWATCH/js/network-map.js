/**
 * Interactive Canvas 2D Network Visualization.
 * Clearly separates ACTUAL observed browser/endpoint telemetry from
 * ILLUSTRATIVE gateway/ISP hops that browsers cannot directly discover.
 *
 * v3:
 *  - Integrates configurable Local Discovery Agent (localhost OR authenticated LAN mode).
 *  - Tracks online & offline discovered devices, measured RTT, first-seen/last-seen history,
 *    and scan diffs (appeared / disappeared / returned).
 *  - Makes every node clickable (mouse click + touch tap, distinct from pan drag) to open
 *    the detailed Device Inspection panel and run authorized reachability / TCP port checks.
 */

import { escapeHtml, formatDateTime, formatMs } from './utils.js';

const AGENT_TIMEOUT_MS = 4500;
const LOCAL_CACHE_KEY = 'netwatch.lan.lastScan.v1';

const TYPE_ICON = {
  'this-device': '💻',
  'router':      '📡',
  'desktop':     '🖥',
  'phone':       '📱',
  'server':      '🖧',
  'iot':         '🔌',
  'unknown':     '❓'
};

export class NetworkMapVisualizer {
  constructor(canvas, inspectorEl) {
    this.canvas = canvas;
    this.inspectorEl = inspectorEl;
    this.ctx = canvas.getContext('2d');

    this.nodes = [];
    this.edges = [];
    this.packets = [];
    this.selectedNodeId = 'client';
    this.hoveredNodeId = null;

    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.pointerDownPos = { x: 0, y: 0 };
    this.didDrag = false;

    this.rafId = null;
    this.lastFrame = performance.now();
    this.active = false;

    this.telemetryState = {
      online: navigator.onLine,
      publicIp: null,
      connType: null,
      endpoints: []
    };

    // Configurable Local Agent settings (no hardcoded tokens!)
    this.agentConfig = {
      host: '127.0.0.1',
      port: 7779,
      token: ''
    };

    // LAN discovery state
    this.agentStatus = 'checking'; // checking | online | auth_required | unavailable | mixed_content
    this.agentInfo = null;
    this.lanDevices = [];
    this.offlineDevices = [];
    this.lastChanges = null;
    this.lastScanAt = null;
    this.lastSuccessfulScanAt = null;
    this.subnetInfo = null;
    this.scanInProgress = false;

    this.onScanStatusChange = null; // callback({ status, ... })
    this.onDeviceClick = null;      // callback(node)

    this._restoreCachedScan();
    this._bindEvents();
  }

  // ── Agent Configuration & Headers ───────────────────────────────────────────

  configureAgent({ host = '127.0.0.1', port = 7779, token = '' }) {
    const cleanHost = (host || '127.0.0.1').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const cleanPort = Math.max(1, Math.min(65535, Number(port) || 7779));
    this.agentConfig = {
      host: cleanHost || '127.0.0.1',
      port: cleanPort,
      token: typeof token === 'string' ? token.trim() : ''
    };
  }

  getAgentBaseUrl() {
    return `http://${this.agentConfig.host}:${this.agentConfig.port}`;
  }

  isMixedContentLikely() {
    const isHttps = window.location.protocol === 'https:';
    const isLoopback = this.agentConfig.host === '127.0.0.1' || this.agentConfig.host === 'localhost';
    return isHttps && !isLoopback;
  }

  _buildHeaders() {
    const headers = {};
    if (this.agentConfig.token) {
      headers['Authorization'] = `Bearer ${this.agentConfig.token}`;
      headers['X-Netwatch-Token'] = this.agentConfig.token;
    }
    return headers;
  }

  _restoreCachedScan() {
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.devices)) {
        // Mark restored devices from previous browser session as cached/last-known
        this.lanDevices = saved.devices;
        this.offlineDevices = Array.isArray(saved.offlineDevices) ? saved.offlineDevices : [];
        this.lastScanAt = saved.scannedAt || null;
        this.lastSuccessfulScanAt = saved.lastSuccessfulScanAt || saved.scannedAt || null;
        this.subnetInfo = saved.cidr ? { cidr: saved.cidr, gateway: saved.gateway, localIp: saved.localIp } : null;
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  _saveCachedScan(data) {
    try {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({
        scannedAt: data.scannedAt,
        lastSuccessfulScanAt: data.lastSuccessfulScanAt || data.scannedAt,
        localIp: data.localIp,
        cidr: data.cidr,
        gateway: data.gateway,
        devices: data.devices || [],
        offlineDevices: data.offlineDevices || []
      }));
    } catch {
      // Ignore quota error
    }
  }

  // ── Event Binding (Mouse + Touch + Wheel) ───────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.didDrag = false;
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.dragStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
        if (dist > 5) this.didDrag = true;
        this.pan.x = e.clientX - this.dragStart.x;
        this.pan.y = e.clientY - this.dragStart.y;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (!this.didDrag) {
        const hit = this._hitTest(e.clientX, e.clientY);
        if (hit) {
          this.selectNode(hit.id, true);
        }
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) return;
      const hit = this._hitTest(e.clientX, e.clientY);
      this.hoveredNodeId = hit ? hit.id : null;
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    });

    // Touch support for phones/tablets
    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      this.isDragging = true;
      this.didDrag = false;
      this.pointerDownPos = { x: t.clientX, y: t.clientY };
      this.dragStart = { x: t.clientX - this.pan.x, y: t.clientY - this.pan.y };
    }, { passive: true });

    this.canvas.addEventListener('touchmove', (e) => {
      if (!this.isDragging || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dist = Math.hypot(t.clientX - this.pointerDownPos.x, t.clientY - this.pointerDownPos.y);
      if (dist > 6) this.didDrag = true;
      this.pan.x = t.clientX - this.dragStart.x;
      this.pan.y = t.clientY - this.dragStart.y;
    }, { passive: true });

    this.canvas.addEventListener('touchend', (e) => {
      if (!this.isDragging) return;
      this.isDragging = false;
      if (!this.didDrag && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        const hit = this._hitTest(t.clientX, t.clientY);
        if (hit) {
          this.selectNode(hit.id, true);
        }
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoom = Math.max(0.45, Math.min(2.8, this.zoom * delta));
    }, { passive: false });
  }

  selectNode(nodeId, openDetails = false) {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    this.selectedNodeId = node.id;
    this._renderInspector(node);
    if (openDetails && typeof this.onDeviceClick === 'function') {
      this.onDeviceClick(node);
    }
    return node;
  }

  resetView() {
    this.pan = { x: 0, y: 0 };
    this.zoom = 1;
  }

  setActive(active) {
    this.active = Boolean(active);
    if (this.active && !this.rafId) {
      this.lastFrame = performance.now();
      this._loop();
    } else if (!this.active && this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.active && this.agentStatus === 'checking') {
      this.checkAgent();
    }
  }

  // ── Telemetry Update ────────────────────────────────────────────────────────

  updateTelemetry({ online, publicIp, connType, endpoints }) {
    this.telemetryState = { online, publicIp, connType, endpoints };
    this._rebuildGraph();
    const selected = this.nodes.find((n) => n.id === this.selectedNodeId) || this.nodes[0];
    if (selected) this._renderInspector(selected);
  }

  // ── Local Agent Communication ───────────────────────────────────────────────

  async checkAgent() {
    if (this.isMixedContentLikely()) {
      this.agentStatus = 'mixed_content';
      this.agentInfo = null;
      this._notifyScanStatus('mixed_content', {
        message: 'Browser blocks HTTPS pages from connecting to HTTP LAN IP addresses. Serve NETWATCH over HTTP on your LAN (start-server.ps1 -Lan) to connect from a phone.'
      });
      return null;
    }

    try {
      const res = await fetch(`${this.getAgentBaseUrl()}/`, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        this.agentInfo = data;
        if (data.authRequired && !data.authenticated) {
          this.agentStatus = 'auth_required';
          this._notifyScanStatus('auth_required', { info: data });
          return data;
        }
        this.agentStatus = 'online';
        this.lastSuccessfulScanAt = data.lastSuccessfulScanAt || this.lastSuccessfulScanAt;
        if (data.cidr || data.localIp) {
          this.subnetInfo = { cidr: data.cidr, gateway: data.gateway, localIp: data.localIp };
        }
        this._notifyScanStatus('idle', { info: data });
        return data;
      }
      if (res.status === 401) {
        this.agentStatus = 'auth_required';
        this._notifyScanStatus('auth_required');
        return null;
      }
    } catch {
      // Unreachable
    }

    this.agentStatus = 'unavailable';
    this.agentInfo = null;
    this._notifyScanStatus('unavailable');
    this._rebuildGraph();
    return null;
  }

  async fetchCachedDevices() {
    if (this.agentStatus !== 'online') {
      await this.checkAgent();
    }
    if (this.agentStatus !== 'online') return null;

    try {
      const res = await fetch(`${this.getAgentBaseUrl()}/devices`, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(8000),
        cache: 'no-store'
      });
      if (res.status === 401) {
        this.agentStatus = 'auth_required';
        this._notifyScanStatus('auth_required');
        return null;
      }
      if (!res.ok) throw new Error(`Agent /devices HTTP ${res.status}`);
      const data = await res.json();

      this.lanDevices = data.devices || [];
      this.offlineDevices = data.offlineDevices || [];
      this.lastChanges = data.changes || null;
      this.lastScanAt = data.scannedAt || this.lastScanAt;
      this.lastSuccessfulScanAt = data.lastSuccessfulScanAt || this.lastSuccessfulScanAt;
      if (data.cidr) {
        this.subnetInfo = { cidr: data.cidr, gateway: data.gateway, localIp: data.localIp };
      }
      if (this.lanDevices.length > 0 || this.offlineDevices.length > 0) {
        this._saveCachedScan(data);
      }
      this._rebuildGraph();
      this._notifyScanStatus('refreshed', {
        count: this.lanDevices.length,
        offlineCount: this.offlineDevices.length,
        scannedAt: this.lastScanAt,
        lastSuccessfulScanAt: this.lastSuccessfulScanAt,
        changes: this.lastChanges,
        message: data.message || null
      });
      return data;
    } catch (err) {
      this._notifyScanStatus('error', { message: err.message });
      return null;
    }
  }

  async scanNetwork() {
    if (this.scanInProgress) return null;
    this.scanInProgress = true;
    this._notifyScanStatus('scanning');

    try {
      if (this.agentStatus !== 'online') {
        await this.checkAgent();
      }
      if (this.agentStatus === 'auth_required') {
        this._notifyScanStatus('auth_required');
        return null;
      }
      if (this.agentStatus === 'mixed_content') {
        return null;
      }
      if (this.agentStatus !== 'online') {
        this._notifyScanStatus('unavailable');
        return null;
      }

      const res = await fetch(`${this.getAgentBaseUrl()}/scan`, {
        headers: this._buildHeaders(),
        signal: AbortSignal.timeout(65000),
        cache: 'no-store'
      });
      if (res.status === 401) {
        this.agentStatus = 'auth_required';
        this._notifyScanStatus('auth_required');
        return null;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `Agent /scan HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.error && !data.devices) {
        throw new Error(data.error);
      }

      this.lanDevices = data.devices || [];
      this.offlineDevices = data.offlineDevices || [];
      this.lastChanges = data.changes || null;
      this.lastScanAt = data.scannedAt || Date.now();
      this.lastSuccessfulScanAt = data.lastSuccessfulScanAt || this.lastScanAt;
      this.subnetInfo = { cidr: data.cidr, gateway: data.gateway, localIp: data.localIp };
      this.agentStatus = 'online';

      this._saveCachedScan(data);
      this._rebuildGraph();
      this._notifyScanStatus('done', {
        count: this.lanDevices.length,
        offlineCount: this.offlineDevices.length,
        scannedAt: this.lastScanAt,
        lastSuccessfulScanAt: this.lastSuccessfulScanAt,
        changes: this.lastChanges
      });
      return data;
    } catch (err) {
      this._notifyScanStatus('error', { message: err.message });
      return null;
    } finally {
      this.scanInProgress = false;
    }
  }

  async inspectDevice(ip, includePorts = true) {
    if (this.agentStatus !== 'online') {
      await this.checkAgent();
    }
    if (this.agentStatus === 'auth_required') {
      throw new Error('Authentication required. Enter your Agent Access Token in Settings.');
    }
    if (this.agentStatus === 'mixed_content') {
      throw new Error('Blocked by browser mixed-content policy (HTTPS page cannot reach HTTP LAN IP).');
    }
    if (this.agentStatus !== 'online') {
      throw new Error('Local Discovery Agent is offline. Start node agent.js to inspect devices.');
    }

    const url = `${this.getAgentBaseUrl()}/inspect?ip=${encodeURIComponent(ip)}&ports=${includePorts ? '1' : '0'}`;
    const res = await fetch(url, {
      headers: this._buildHeaders(),
      signal: AbortSignal.timeout(20000),
      cache: 'no-store'
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      this.agentStatus = 'auth_required';
      this._notifyScanStatus('auth_required');
      throw new Error(body.error || 'Agent authentication required.');
    }
    if (!res.ok) {
      throw new Error(body.error || `Inspection failed (HTTP ${res.status})`);
    }

    // Update cached device entry with fresh RTT / status
    const all = [...this.lanDevices, ...this.offlineDevices];
    const match = all.find((d) => d.ip === ip);
    if (match && body.reachability) {
      match.status = body.status;
      match.rttMs = body.reachability.avgRttMs;
      if (body.history && body.history.lastSeen) match.lastSeen = body.history.lastSeen;
      if (body.history && body.history.events) match.events = body.history.events;
      if (body.mac && body.mac !== 'Unavailable') match.mac = body.mac;
      if (body.hostname) match.hostname = body.hostname;
      this._rebuildGraph();
    }

    return body;
  }

  getAllKnownDevices() {
    return [...this.lanDevices, ...this.offlineDevices];
  }

  _notifyScanStatus(status, extra = {}) {
    if (typeof this.onScanStatusChange === 'function') {
      this.onScanStatusChange({ status, ...extra });
    }
  }

  // ── Graph Construction ──────────────────────────────────────────────────────

  _rebuildGraph() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 720;
    const h = rect.height || 460;

    const allKnown = [...this.lanDevices, ...this.offlineDevices];
    const hasLan = allKnown.length > 0;
    const eps = this.telemetryState.endpoints || [];

    const colClient = hasLan ? w * 0.12 : w * 0.16;
    const colLan = w * 0.34;
    const colGateway = hasLan ? w * 0.56 : w * 0.46;
    const colTargets = hasLan ? w * 0.80 : w * 0.78;
    const centerY = h * 0.5;

    const nodes = [];
    const edges = [];

    const localDev = this.lanDevices.find((d) => d.isLocalDevice);
    const gwDevice = allKnown.find((d) => d.isGateway);

    // Client / Host node
    nodes.push({
      id: 'client',
      kind: 'lan',
      x: colClient,
      y: centerY,
      radius: 26,
      label: localDev?.hostname || 'This Device',
      sublabel: localDev ? localDev.ip : (this.telemetryState.connType || (this.telemetryState.online ? 'Online' : 'Offline')),
      provenance: 'ACTUAL',
      status: this.telemetryState.online ? 'ok' : 'error',
      icon: '💻',
      device: localDev || null,
      meta: {
        Role: 'Local Client Device',
        'Local IP': localDev?.ip || 'Requires Local Agent',
        'MAC Address': localDev?.mac || 'Requires Local Agent',
        'Browser Online': this.telemetryState.online ? 'Yes' : 'No',
        'Interface Info': this.telemetryState.connType || 'Not exposed by browser',
        'Public IP': this.telemetryState.publicIp || 'Pending / Unavailable'
      }
    });

    // LAN peer devices (excluding local device and gateway)
    if (hasLan) {
      const peers = allKnown.filter((d) => !d.isGateway && !d.isLocalDevice);
      const totalLan = peers.length;
      const spanLan = Math.min(h * 0.82, Math.max(90, totalLan * 74));
      const startLanY = centerY - spanLan / 2;

      peers.forEach((device, idx) => {
        const y = totalLan <= 1 ? centerY : startLanY + (spanLan * idx) / (totalLan - 1);
        const nodeId = `lan-${device.ip.replace(/\./g, '-')}`;
        const isOnline = device.status === 'online';
        const rttSub = isOnline && typeof device.rttMs === 'number'
          ? `${device.rttMs < 1 ? '<1' : device.rttMs.toFixed(0)} ms`
          : (isOnline ? (device.vendor !== 'Unknown' ? device.vendor : device.ip) : 'Offline');

        nodes.push({
          id: nodeId,
          kind: 'lan',
          x: colLan,
          y,
          radius: 20,
          label: device.hostname || device.ip,
          sublabel: rttSub,
          provenance: 'ACTUAL',
          status: isOnline ? 'ok' : 'offline',
          icon: TYPE_ICON[device.type] || '❓',
          device,
          meta: {
            'IP Address': device.ip,
            'MAC Address': device.mac || 'Unavailable',
            Vendor: device.vendor || 'Unknown',
            Hostname: device.hostname || 'Unresolved',
            'Device Type': `${device.type}${device.typeEstimated !== false ? ' (Estimated)' : ''}`,
            Status: isOnline ? 'Online' : 'Offline',
            'Response Time': typeof device.rttMs === 'number' ? formatMs(device.rttMs) : 'Unavailable',
            'Last Seen': device.lastSeen ? formatDateTime(device.lastSeen) : '—'
          }
        });

        edges.push({
          from: nodeId,
          to: 'gateway',
          status: isOnline ? 'ok' : 'offline',
          rttMs: typeof device.rttMs === 'number' ? device.rttMs : null,
          illustrative: false,
          lan: true
        });
      });
    }

    // Router / Default Gateway node
    nodes.push({
      id: 'gateway',
      kind: gwDevice ? 'lan' : 'illustrative',
      x: colGateway,
      y: centerY,
      radius: 24,
      label: gwDevice ? (gwDevice.hostname || 'Router / Gateway') : 'Router / Gateway',
      sublabel: gwDevice ? gwDevice.ip : 'Illustrative Hop',
      provenance: gwDevice ? 'ACTUAL' : 'ILLUSTRATIVE',
      status: this.telemetryState.online ? (gwDevice ? (gwDevice.status === 'online' ? 'ok' : 'offline') : 'inferred') : 'error',
      icon: '📡',
      device: gwDevice || null,
      meta: gwDevice ? {
        Role: 'Confirmed Default Gateway',
        'Gateway IP': gwDevice.ip,
        'MAC Address': gwDevice.mac || 'Unavailable',
        Vendor: gwDevice.vendor || 'Unknown',
        Subnet: gwDevice.subnet || this.subnetInfo?.cidr || '—',
        'Response Time': typeof gwDevice.rttMs === 'number' ? formatMs(gwDevice.rttMs) : 'Unavailable',
        'Public Egress IP': this.telemetryState.publicIp || 'Unavailable'
      } : {
        Role: 'Inferred Transit Path',
        Provenance: 'Illustrative only — browsers cannot query LAN routers. Start NETWATCH Agent to discover your real gateway.',
        'Public Egress IP': this.telemetryState.publicIp || 'Unavailable'
      }
    });

    edges.push({
      from: 'client',
      to: 'gateway',
      status: this.telemetryState.online ? (gwDevice ? 'ok' : 'inferred') : 'error',
      rttMs: gwDevice && typeof gwDevice.rttMs === 'number' ? gwDevice.rttMs : null,
      illustrative: !gwDevice,
      lan: Boolean(gwDevice)
    });

    // External Monitored HTTP Endpoints
    const span = Math.min(h * 0.72, Math.max(120, eps.length * 105));
    const startY = centerY - span / 2;

    eps.forEach((ep, idx) => {
      const y = eps.length === 1 ? centerY : startY + (span * idx) / (eps.length - 1);
      const last = ep.lastSample;
      const isOk = ep.enabled ? (last ? last.ok : true) : false;
      const status = !ep.enabled ? 'disabled' : (last ? (last.ok ? 'ok' : 'error') : 'pending');

      nodes.push({
        id: ep.id,
        kind: 'endpoint',
        x: colTargets,
        y,
        radius: 22,
        label: ep.name,
        sublabel: last && last.ok ? formatMs(last.rttMs) : (ep.enabled ? (last?.error || 'Pending') : 'Disabled'),
        provenance: 'ACTUAL',
        status,
        icon: '🌐',
        device: null,
        endpoint: ep,
        meta: {
          Role: 'Monitored HTTP Endpoint',
          URL: ep.url,
          Enabled: ep.enabled ? 'Yes' : 'No',
          'Last RTT': last && last.ok ? formatMs(last.rttMs) : 'Unavailable',
          'Avg RTT': ep.avgRtt !== null ? formatMs(ep.avgRtt) : '—',
          'Failure Rate': `${ep.failRate.toFixed(1)}%`
        }
      });

      edges.push({
        from: 'gateway',
        to: ep.id,
        status: isOk ? 'ok' : 'error',
        rttMs: last && last.ok ? last.rttMs : null,
        illustrative: false,
        lan: false
      });
    });

    this.nodes = nodes;
    this.edges = edges;

    if (this.packets.length === 0 || this.packets.length !== edges.length * 2) {
      this.packets = [];
      edges.forEach((_edge, i) => {
        this.packets.push({ edgeIdx: i, t: 0.15, dir: 1 });
        this.packets.push({ edgeIdx: i, t: 0.65, dir: -1 });
      });
    }
  }

  // ── Hit Testing & Side Inspector ────────────────────────────────────────────

  _hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = (clientX - rect.left - this.pan.x) / this.zoom;
    const my = (clientY - rect.top - this.pan.y) / this.zoom;
    return this.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) <= n.radius + 10) || null;
  }

  _renderInspector(node) {
    if (!this.inspectorEl || !node) return;
    const badgeClass = node.provenance === 'ACTUAL' ? 'badge--actual' : 'badge--estimated';
    const rows = Object.entries(node.meta)
      .map(([k, v]) => `
        <div class="cap-item">
          <div class="muted-label">${escapeHtml(k)}</div>
          <div class="mono-val" style="word-break:break-word;font-size:12px;">${escapeHtml(String(v))}</div>
        </div>
      `)
      .join('');

    const inspectBtnHtml = node.device
      ? `<button class="btn btn-primary btn-xs" type="button" data-open-device-modal="${escapeHtml(node.id)}" style="width:100%;margin-top:4px;">Open Full Device Inspector</button>`
      : '';

    this.inspectorEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <strong style="font-size:14px;">${escapeHtml(node.icon || '')} ${escapeHtml(node.label)}</strong>
        <span class="badge ${badgeClass}">${escapeHtml(node.provenance)}</span>
      </div>
      ${rows}
      ${inspectBtnHtml}
    `;
  }

  // ── Render Loop ─────────────────────────────────────────────────────────────

  _loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this._draw(dt);
    if (this.active) {
      this.rafId = requestAnimationFrame(() => this._loop());
    }
  }

  _draw(dt) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._rebuildGraph();
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Subtle grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < rect.width; gx += 32) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, rect.height); ctx.stroke();
    }
    for (let gy = 0; gy < rect.height; gy += 32) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(rect.width, gy); ctx.stroke();
    }

    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

    // Draw edges
    for (const edge of this.edges) {
      const a = nodeMap.get(edge.from);
      const b = nodeMap.get(edge.to);
      if (!a || !b) continue;

      ctx.save();
      ctx.beginPath();
      if (edge.illustrative || edge.status === 'offline') ctx.setLineDash([6, 5]);
      ctx.strokeStyle = edge.status === 'error'
        ? 'rgba(239, 68, 68, 0.65)'
        : edge.status === 'offline'
          ? 'rgba(148, 163, 184, 0.35)'
          : edge.illustrative
            ? 'rgba(139, 92, 246, 0.55)'
            : edge.lan
              ? 'rgba(16, 185, 129, 0.6)'
              : 'rgba(0, 229, 255, 0.52)';
      ctx.lineWidth = edge.lan ? 1.75 : 2;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // Animate packets
    for (const pkt of this.packets) {
      const edge = this.edges[pkt.edgeIdx];
      if (!edge || edge.status === 'error' || edge.status === 'disabled' || edge.status === 'offline') continue;
      const a = nodeMap.get(edge.from);
      const b = nodeMap.get(edge.to);
      if (!a || !b) continue;

      const speed = edge.rttMs ? Math.max(0.25, Math.min(1.1, 45 / Math.max(1, edge.rttMs))) : 0.4;
      pkt.t += pkt.dir * speed * dt;
      if (pkt.t > 1) pkt.t = 0;
      if (pkt.t < 0) pkt.t = 1;

      const px = a.x + (b.x - a.x) * pkt.t;
      const py = a.y + (b.y - a.y) * pkt.t;

      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = edge.illustrative ? '#8b5cf6' : edge.lan ? '#10b981' : '#00e5ff';
      ctx.fill();
    }

    // Draw nodes
    for (const node of this.nodes) {
      const isSelected = node.id === this.selectedNodeId;
      const isHovered = node.id === this.hoveredNodeId;

      const color = node.status === 'error'
        ? '#ef4444'
        : node.status === 'offline'
          ? '#64748b'
          : node.status === 'inferred'
            ? '#8b5cf6'
            : node.status === 'disabled'
              ? '#64748b'
              : node.status === 'pending'
                ? '#f59e0b'
                : node.kind === 'lan'
                  ? '#10b981'
                  : '#00e5ff';

      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.status === 'offline' ? '#0f172a' : '#111827';
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = color;
      ctx.stroke();

      // Online/offline status indicator dot on node rim
      ctx.beginPath();
      ctx.arc(node.x + node.radius * 0.72, node.y - node.radius * 0.72, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = node.status === 'ok' ? '#10b981' : node.status === 'offline' ? '#ef4444' : color;
      ctx.fill();
      ctx.strokeStyle = '#080b12';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (node.icon) {
        ctx.font = `${Math.round(node.radius * 0.85)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = node.status === 'offline' ? 0.55 : 1;
        ctx.fillText(node.icon, node.x, node.y + 1);
        ctx.globalAlpha = 1;
      }

      // Labels
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = node.status === 'offline' ? '#94a3b8' : '#e5e7eb';
      ctx.font = '600 11.5px Inter, sans-serif';
      ctx.textAlign = 'center';
      const shortLabel = node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label;
      ctx.fillText(shortLabel, node.x, node.y + node.radius + 15);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(node.sublabel, node.x, node.y + node.radius + 28);
    }

    ctx.restore();

    // Subtle non-blocking hint pill in top-right when agent is offline/auth_required
    if (this.agentStatus === 'unavailable' || this.agentStatus === 'auth_required' || this.agentStatus === 'mixed_content') {
      const msg = this.agentStatus === 'auth_required'
        ? 'Agent requires access token — configure in Settings'
        : this.agentStatus === 'mixed_content'
          ? 'HTTPS blocked HTTP LAN agent — serve locally via start-server.ps1 -Lan'
          : 'Click any node to inspect · Start local agent for LAN discovery';
      ctx.save();
      ctx.font = '500 11px Inter, sans-serif';
      const tw = ctx.measureText(msg).width;
      const bw = Math.min(rect.width - 24, tw + 22);
      const bx = rect.width - bw - 12;
      const by = 12;
      ctx.fillStyle = 'rgba(8, 11, 18, 0.85)';
      ctx.strokeStyle = this.agentStatus === 'auth_required' ? 'rgba(245, 158, 11, 0.55)' : 'rgba(148, 163, 184, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 26, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.agentStatus === 'auth_required' ? '#fcd34d' : '#94a3b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(msg, bx + 11, by + 13, bw - 22);
      ctx.restore();
    }
  }
}
