/**
 * Interactive Canvas 2D Network Visualization.
 * Clearly separates ACTUAL observed browser/endpoint telemetry from
 * ILLUSTRATIVE gateway/ISP hops that browsers cannot directly discover.
 *
 * v2: Integrates real LAN device discovery from the NETWATCH Local Agent
 *     (http://127.0.0.1:7779/). Falls back gracefully if agent is unavailable.
 */

import { escapeHtml, formatMs } from './utils.js';

const AGENT_BASE = 'http://127.0.0.1:7779';
const AGENT_TIMEOUT_MS = 4000;

// Device type → icon label mapping (drawn inside Canvas nodes)
const TYPE_ICON = {
  'this-device': '💻',
  'router':      '📡',
  'desktop':     '🖥',
  'phone':       '📱',
  'server':      '🖧',
  'iot':         '🔌',
  'unknown':     '?'
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

    this.rafId = null;
    this.lastFrame = performance.now();
    this.active = false;

    this.telemetryState = {
      online: navigator.onLine,
      publicIp: null,
      connType: null,
      endpoints: []
    };

    // LAN discovery state
    this.agentAvailable = null;   // null = unknown, true/false after check
    this.lanDevices = [];         // last good scan result
    this.lastScanAt = null;
    this.scanInProgress = false;
    this.onScanStatusChange = null; // callback(status) set by app.js

    this._bindEvents();
  }

  // ── Event binding (unchanged from v1) ───────────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.clientX - this.pan.x, y: e.clientY - this.pan.y };
      const hit = this._hitTest(e);
      if (hit) {
        this.selectedNodeId = hit.id;
        this._renderInspector(hit);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        this.pan.x = e.clientX - this.dragStart.x;
        this.pan.y = e.clientY - this.dragStart.y;
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) return;
      const hit = this._hitTest(e);
      this.hoveredNodeId = hit ? hit.id : null;
      this.canvas.style.cursor = hit ? 'pointer' : 'grab';
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      this.zoom = Math.max(0.4, Math.min(3.0, this.zoom * delta));
    }, { passive: false });
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
    // Probe agent when panel becomes active
    if (this.active && this.agentAvailable === null) {
      this.checkAgent();
    }
  }

  // ── Telemetry update (called by app.js on each latency/status update) ───────

  updateTelemetry({ online, publicIp, connType, endpoints }) {
    this.telemetryState = { online, publicIp, connType, endpoints };
    this._rebuildGraph();
    const selected = this.nodes.find((n) => n.id === this.selectedNodeId) || this.nodes[0];
    if (selected) this._renderInspector(selected);
  }

  // ── Local Agent communication ────────────────────────────────────────────────

  async checkAgent() {
    try {
      const res = await fetch(`${AGENT_BASE}/`, {
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
        cache: 'no-store'
      });
      if (res.ok) {
        const data = await res.json();
        this.agentAvailable = true;
        this._notifyScanStatus('idle');
        return data;
      }
    } catch { /* fall through */ }
    this.agentAvailable = false;
    this._notifyScanStatus('unavailable');
    this._rebuildGraph();
    return null;
  }

  async scanNetwork() {
    if (this.scanInProgress) return;
    this.scanInProgress = true;
    this._notifyScanStatus('scanning');

    try {
      // Ensure agent is reachable
      if (this.agentAvailable === null || this.agentAvailable === false) {
        await this.checkAgent();
      }
      if (!this.agentAvailable) {
        this._notifyScanStatus('unavailable');
        return;
      }

      const res = await fetch(`${AGENT_BASE}/scan`, {
        signal: AbortSignal.timeout(60000), // scan can take up to ~30 s
        cache: 'no-store'
      });
      if (!res.ok) throw new Error(`Agent /scan HTTP ${res.status}`);
      const data = await res.json();

      if (data.error && !data.devices) {
        throw new Error(data.error);
      }

      this.lanDevices = data.devices || [];
      this.lastScanAt = data.scannedAt || Date.now();
      this.agentAvailable = true;
      this._rebuildGraph();
      this._notifyScanStatus('done', {
        count: this.lanDevices.length,
        scannedAt: this.lastScanAt
      });
    } catch (err) {
      this._notifyScanStatus('error', { message: err.message });
    } finally {
      this.scanInProgress = false;
    }
  }

  _notifyScanStatus(status, extra = {}) {
    if (typeof this.onScanStatusChange === 'function') {
      this.onScanStatusChange({ status, ...extra });
    }
  }

  // ── Graph construction ───────────────────────────────────────────────────────

  _rebuildGraph() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 720;
    const h = rect.height || 440;

    const hasLan  = this.lanDevices.length > 0;
    const eps     = this.telemetryState.endpoints || [];

    // ── Column X positions depend on whether LAN column exists ──────────────
    // Layout: Client | LAN Devices | Gateway | Internet Endpoints
    const colClient  = hasLan ? w * 0.11 : w * 0.16;
    const colLan     = w * 0.30;
    const colGateway = hasLan ? w * 0.52 : w * 0.46;
    const colTargets = hasLan ? w * 0.76 : w * 0.78;
    const centerY    = h * 0.5;

    const nodes = [];
    const edges = [];

    // ── Client node (always present) ─────────────────────────────────────────
    nodes.push({
      id: 'client',
      x: colClient,
      y: centerY,
      radius: 26,
      label: 'This Device',
      sublabel: this.telemetryState.connType || (this.telemetryState.online ? 'Online' : 'Offline'),
      provenance: 'ACTUAL',
      status: this.telemetryState.online ? 'ok' : 'error',
      icon: '💻',
      meta: {
        Role: 'Local Client Browser',
        'Browser Online': this.telemetryState.online ? 'Yes' : 'No',
        'Interface Info': this.telemetryState.connType || 'Not exposed by browser',
        'Public IP': this.telemetryState.publicIp || 'Pending / Unavailable'
      }
    });

    // ── LAN device nodes ─────────────────────────────────────────────────────
    if (hasLan) {
      const nonGateway = this.lanDevices.filter((d) => !d.isGateway && !d.isLocalDevice);
      const totalLan   = nonGateway.length;
      const spanLan    = Math.min(h * 0.80, Math.max(80, totalLan * 70));
      const startLanY  = centerY - spanLan / 2;

      nonGateway.forEach((device, idx) => {
        const y = totalLan <= 1 ? centerY : startLanY + (spanLan * idx) / (totalLan - 1);
        const nodeId = `lan-${device.ip.replace(/\./g, '-')}`;
        nodes.push({
          id: nodeId,
          x: colLan,
          y,
          radius: 20,
          label: device.hostname || device.ip,
          sublabel: device.vendor !== 'Unknown' ? device.vendor : device.ip,
          provenance: 'ACTUAL',
          status: device.status === 'online' ? 'ok' : 'error',
          icon: TYPE_ICON[device.type] || '?',
          meta: {
            'IP Address':  device.ip,
            'MAC Address': device.mac,
            Vendor:        device.vendor,
            Hostname:      device.hostname || 'Unresolved',
            'Device Type': device.type,
            'Last Seen':   device.lastSeen ? new Date(device.lastSeen).toLocaleTimeString() : '—',
            Status:        device.status
          }
        });

        // Edge: client → LAN device (they share a switch)
        edges.push({
          from: 'client',
          to: nodeId,
          status: 'ok',
          rttMs: null,
          illustrative: false,
          lan: true
        });
      });
    }

    // ── Gateway node ─────────────────────────────────────────────────────────
    const gwDevice = this.lanDevices.find((d) => d.isGateway);
    nodes.push({
      id: 'gateway',
      x: colGateway,
      y: centerY,
      radius: 24,
      label: gwDevice ? (gwDevice.hostname || gwDevice.ip) : 'Router / Gateway',
      sublabel: gwDevice ? `${gwDevice.vendor} · ${gwDevice.ip}` : 'Illustrative hop',
      provenance: gwDevice ? 'ACTUAL' : 'ILLUSTRATIVE',
      status: this.telemetryState.online ? (gwDevice ? 'ok' : 'inferred') : 'error',
      icon: '📡',
      meta: gwDevice ? {
        Role:          'Default Gateway / Router',
        'IP Address':  gwDevice.ip,
        'MAC Address': gwDevice.mac,
        Vendor:        gwDevice.vendor,
        Hostname:      gwDevice.hostname || 'Unresolved',
        'Public Egress': this.telemetryState.publicIp || 'Unavailable',
        Provenance:    'Discovered via local agent ARP/ping scan'
      } : {
        Role:       'Inferred Transit Path',
        Provenance: 'Illustrative only — browsers cannot query LAN routers. Install local agent for real data.',
        'Public Egress IP': this.telemetryState.publicIp || 'Unavailable'
      }
    });

    // Edge: client → gateway
    edges.push({
      from: 'client',
      to: 'gateway',
      status: this.telemetryState.online ? (gwDevice ? 'ok' : 'inferred') : 'error',
      rttMs: null,
      illustrative: !gwDevice,
      lan: true
    });

    // ── LAN device → gateway edges ────────────────────────────────────────────
    if (hasLan) {
      const nonGateway = this.lanDevices.filter((d) => !d.isGateway && !d.isLocalDevice);
      nonGateway.forEach((device) => {
        const nodeId = `lan-${device.ip.replace(/\./g, '-')}`;
        edges.push({
          from: nodeId,
          to: 'gateway',
          status: device.status === 'online' ? 'ok' : 'error',
          rttMs: null,
          illustrative: false,
          lan: true
        });
      });
    }

    // ── Internet endpoint nodes ───────────────────────────────────────────────
    const span   = Math.min(h * 0.72, Math.max(120, eps.length * 105));
    const startY = centerY - span / 2;

    eps.forEach((ep, idx) => {
      const y     = eps.length === 1 ? centerY : startY + (span * idx) / (eps.length - 1);
      const last  = ep.lastSample;
      const isOk  = ep.enabled ? (last ? last.ok : true) : false;
      const status = !ep.enabled ? 'disabled' : (last ? (last.ok ? 'ok' : 'error') : 'pending');

      nodes.push({
        id:        ep.id,
        x:         colTargets,
        y,
        radius:    22,
        label:     ep.name,
        sublabel:  last && last.ok ? formatMs(last.rttMs) : (ep.enabled ? (last?.error || 'Pending') : 'Disabled'),
        provenance: 'ACTUAL',
        status,
        icon: '🌐',
        meta: {
          Role:           'Monitored HTTP Endpoint',
          URL:            ep.url,
          Enabled:        ep.enabled ? 'Yes' : 'No',
          'Last RTT':     last && last.ok ? formatMs(last.rttMs) : 'Unavailable',
          'Avg RTT':      ep.avgRtt !== null ? formatMs(ep.avgRtt) : '—',
          'Failure Rate': `${ep.failRate.toFixed(1)}%`
        }
      });

      edges.push({
        from:        'gateway',
        to:          ep.id,
        status:      isOk ? 'ok' : 'error',
        rttMs:       last && last.ok ? last.rttMs : null,
        illustrative: false,
        lan: false
      });
    });

    this.nodes = nodes;
    this.edges = edges;

    // Sync packet particles
    if (this.packets.length === 0 || this.packets.length !== edges.length * 2) {
      this.packets = [];
      edges.forEach((edge, i) => {
        this.packets.push({ edgeIdx: i, t: 0.15, dir: 1 });
        this.packets.push({ edgeIdx: i, t: 0.65, dir: -1 });
      });
    }
  }

  // ── Hit testing (unchanged) ──────────────────────────────────────────────────

  _hitTest(event) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = (event.clientX - rect.left - this.pan.x) / this.zoom;
    const my = (event.clientY - rect.top  - this.pan.y) / this.zoom;
    return this.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) <= n.radius + 8) || null;
  }

  // ── Inspector panel ──────────────────────────────────────────────────────────

  _renderInspector(node) {
    if (!this.inspectorEl || !node) return;
    const badgeClass = node.provenance === 'ACTUAL' ? 'badge--actual' : 'badge--estimated';
    const rows = Object.entries(node.meta)
      .map(([k, v]) =>
        `<div class="cap-item"><div class="muted-label">${escapeHtml(k)}</div><div class="mono-val" style="word-break:break-all">${escapeHtml(String(v))}</div></div>`
      ).join('');

    this.inspectorEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <strong style="font-size:15px;">${escapeHtml(node.icon || '')} ${escapeHtml(node.label)}</strong>
        <span class="badge ${badgeClass}">${escapeHtml(node.provenance)}</span>
      </div>
      ${rows}
    `;
  }

  // ── Render loop ──────────────────────────────────────────────────────────────

  _loop() {
    const now = performance.now();
    const dt  = Math.min(0.05, (now - this.lastFrame) / 1000);
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
    const w   = Math.round(rect.width * dpr);
    const h   = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width  = w;
      this.canvas.height = h;
      this._rebuildGraph();
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    // Grid
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
      if (edge.illustrative) ctx.setLineDash([6, 5]);
      ctx.strokeStyle = edge.status === 'error'
        ? 'rgba(239, 68, 68, 0.65)'
        : edge.illustrative
          ? 'rgba(139, 92, 246, 0.55)'
          : edge.lan
            ? 'rgba(22, 163, 74, 0.55)'   // green for LAN links
            : 'rgba(0, 229, 255, 0.5)';    // cyan for internet links
      ctx.lineWidth = edge.lan ? 1.5 : 2;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // Animate packets
    for (const pkt of this.packets) {
      const edge = this.edges[pkt.edgeIdx];
      if (!edge || edge.status === 'error' || edge.status === 'disabled') continue;
      const a = nodeMap.get(edge.from);
      const b = nodeMap.get(edge.to);
      if (!a || !b) continue;

      const speed = edge.rttMs ? Math.max(0.25, Math.min(1.1, 45 / edge.rttMs)) : 0.4;
      pkt.t += pkt.dir * speed * dt;
      if (pkt.t > 1) pkt.t = 0;
      if (pkt.t < 0) pkt.t = 1;

      const px = a.x + (b.x - a.x) * pkt.t;
      const py = a.y + (b.y - a.y) * pkt.t;

      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fillStyle = edge.illustrative ? '#8b5cf6'
                    : edge.lan          ? '#16a34a'
                    :                     '#00e5ff';
      ctx.fill();
    }

    // Draw nodes
    for (const node of this.nodes) {
      const isSelected = node.id === this.selectedNodeId;
      const isHovered  = node.id === this.hoveredNodeId;

      const color = node.status === 'error'    ? '#ef4444'
                  : node.status === 'inferred' ? '#8b5cf6'
                  : node.status === 'disabled' ? '#64748b'
                  : node.status === 'pending'  ? '#f59e0b'
                  :                              '#00e5ff';

      // Selection ring
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#1f2937';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();

      // Icon inside node
      if (node.icon) {
        ctx.font = `${Math.round(node.radius * 0.9)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.icon, node.x, node.y);
      } else {
        ctx.fillStyle = color;
        ctx.font = '600 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(node.provenance === 'ACTUAL' ? 'LIVE' : 'EST', node.x, node.y + 3);
      }

      // Labels
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#f3f4f6';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(node.label, node.x, node.y + node.radius + 15);

      ctx.fillStyle = '#9ca3af';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(node.sublabel, node.x, node.y + node.radius + 28);
    }

    // Agent unavailable overlay
    if (this.agentAvailable === false && this.lanDevices.length === 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(17,24,39,0.6)';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#f59e0b';
      ctx.font = '600 14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⚠ Local Discovery Agent unavailable', rect.width / 2, rect.height / 2 - 18);
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Run: node agent.js  in your NETWATCH folder', rect.width / 2, rect.height / 2 + 12);
      ctx.fillText('The map shows internet endpoints only while offline.', rect.width / 2, rect.height / 2 + 32);
      ctx.restore();
    }

    ctx.restore();
  }
}
