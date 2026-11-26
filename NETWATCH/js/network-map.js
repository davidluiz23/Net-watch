/**
 * Interactive Canvas 2D Network Visualization.
 * Clearly separates ACTUAL observed browser/endpoint telemetry from
 * ILLUSTRATIVE gateway/ISP hops that browsers cannot directly discover.
 */

import { escapeHtml, formatMs } from './utils.js';

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

    this._bindEvents();
  }

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
      this.zoom = Math.max(0.6, Math.min(2.2, this.zoom * delta));
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
  }

  updateTelemetry({ online, publicIp, connType, endpoints }) {
    this.telemetryState = { online, publicIp, connType, endpoints };
    this._rebuildGraph();
    const selected = this.nodes.find((n) => n.id === this.selectedNodeId) || this.nodes[0];
    if (selected) this._renderInspector(selected);
  }

  _rebuildGraph() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 720;
    const h = rect.height || 440;

    const clientX = w * 0.16;
    const midX = w * 0.46;
    const targetX = w * 0.78;
    const centerY = h * 0.5;

    const nodes = [
      {
        id: 'client',
        x: clientX,
        y: centerY,
        radius: 26,
        label: 'This Browser',
        sublabel: this.telemetryState.connType || (this.telemetryState.online ? 'Online' : 'Offline'),
        provenance: 'ACTUAL',
        status: this.telemetryState.online ? 'ok' : 'error',
        meta: {
          Role: 'Local Client Device',
          'Browser Online': this.telemetryState.online ? 'Yes' : 'No',
          'Interface Info': this.telemetryState.connType || 'Not exposed',
          'Public IP': this.telemetryState.publicIp || 'Pending / Unavailable'
        }
      },
      {
        id: 'gateway',
        x: midX,
        y: centerY,
        radius: 24,
        label: 'Local Gateway / ISP',
        sublabel: 'Illustrative Hop',
        provenance: 'ILLUSTRATIVE',
        status: this.telemetryState.online ? 'inferred' : 'error',
        meta: {
          Role: 'Inferred Transit Path',
          Provenance: 'Illustrative only — browsers cannot query LAN routers, ARP tables, or ICMP traceroute hops.',
          'Public Egress IP': this.telemetryState.publicIp || 'Unavailable'
        }
      }
    ];

    const edges = [
      {
        from: 'client',
        to: 'gateway',
        status: this.telemetryState.online ? 'inferred' : 'error',
        rttMs: null,
        illustrative: true
      }
    ];

    const eps = this.telemetryState.endpoints || [];
    const span = Math.min(h * 0.72, Math.max(120, eps.length * 105));
    const startY = centerY - span / 2;

    eps.forEach((ep, idx) => {
      const y = eps.length === 1 ? centerY : startY + (span * idx) / (eps.length - 1);
      const last = ep.lastSample;
      const isOk = ep.enabled ? (last ? last.ok : true) : false;
      const status = !ep.enabled ? 'disabled' : (last ? (last.ok ? 'ok' : 'error') : 'pending');

      nodes.push({
        id: ep.id,
        x: targetX,
        y,
        radius: 22,
        label: ep.name,
        sublabel: last && last.ok ? formatMs(last.rttMs) : (ep.enabled ? (last?.error || 'Pending') : 'Disabled'),
        provenance: 'ACTUAL',
        status,
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
        illustrative: false
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

  _hitTest(event) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = (event.clientX - rect.left - this.pan.x) / this.zoom;
    const my = (event.clientY - rect.top - this.pan.y) / this.zoom;
    return this.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) <= n.radius + 8) || null;
  }

  _renderInspector(node) {
    if (!this.inspectorEl || !node) return;
    const badgeClass = node.provenance === 'ACTUAL' ? 'badge--actual' : 'badge--estimated';
    const rows = Object.entries(node.meta)
      .map(([k, v]) => `<div class="cap-item"><div class="muted-label">${escapeHtml(k)}</div><div class="mono-val">${escapeHtml(v)}</div></div>`)
      .join('');

    this.inspectorEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <strong>${escapeHtml(node.label)}</strong>
        <span class="badge ${badgeClass}">${escapeHtml(node.provenance)}</span>
      </div>
      ${rows}
    `;
  }

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

    // Subtle grid background
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < rect.width; gx += 32) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, rect.height);
      ctx.stroke();
    }
    for (let gy = 0; gy < rect.height; gy += 32) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(rect.width, gy);
      ctx.stroke();
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
          : 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 2;
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

      const speed = edge.rttMs ? Math.max(0.25, Math.min(1.1, 45 / edge.rttMs)) : 0.45;
      pkt.t += pkt.dir * speed * dt;
      if (pkt.t > 1) pkt.t = 0;
      if (pkt.t < 0) pkt.t = 1;

      const px = a.x + (b.x - a.x) * pkt.t;
      const py = a.y + (b.y - a.y) * pkt.t;

      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = edge.illustrative ? '#8b5cf6' : '#00e5ff';
      ctx.fill();
    }

    // Draw nodes
    for (const node of this.nodes) {
      const isSelected = node.id === this.selectedNodeId;
      const isHovered = node.id === this.hoveredNodeId;

      const color = node.status === 'error'
        ? '#ef4444'
        : node.status === 'inferred'
          ? '#8b5cf6'
          : node.status === 'disabled'
            ? '#64748b'
            : '#00e5ff';

      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 6, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = '#111827';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();

      // Provenance tag inside node
      ctx.fillStyle = color;
      ctx.font = '600 9px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(node.provenance === 'ACTUAL' ? 'LIVE' : 'EST', node.x, node.y + 3);

      // Node labels
      ctx.fillStyle = '#e5e7eb';
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillText(node.label, node.x, node.y + node.radius + 16);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px JetBrains Mono, monospace';
      ctx.fillText(node.sublabel, node.x, node.y + node.radius + 31);
    }

    ctx.restore();
  }
}
