#!/usr/bin/env node
/**
 * NETWATCH Local Discovery Agent
 * ================================
 * Lightweight Node.js HTTP server bound exclusively to 127.0.0.1:7779.
 * Provides a documented REST API so the NETWATCH browser app can discover
 * devices on the local subnet. All scans are limited to the detected
 * local RFC-1918 subnet. No internet scanning, no credential attempts,
 * no packet capture.
 *
 * API endpoints:
 *   GET  /           Health check + agent version
 *   GET  /network    Local network info (IP, subnet, gateway)
 *   GET  /scan       Run ARP/ping sweep of local subnet, return devices
 *   GET  /devices    Return last cached scan results
 *
 * Requires Node.js 18+ (no external npm packages needed).
 * Uses: os, child_process, http — all built-in.
 *
 * Usage:
 *   node agent.js
 */

'use strict';

const http  = require('http');
const os    = require('os');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execAsync    = promisify(exec);
const execFileAsync = promisify(execFile);

const PORT    = 7779;
const HOST    = '127.0.0.1';
const VERSION = '1.0.0';

// ── Utility helpers ──────────────────────────────────────────────────────────

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24), (long >>> 16 & 0xff), (long >>> 8 & 0xff), (long & 0xff)].join('.');
}

function cidrToMask(prefix) {
  return (~0 << (32 - prefix)) >>> 0;
}

function subnetHosts(ip, prefix) {
  if (prefix < 16) prefix = 24; // Safety: never scan more than a /16
  const mask    = cidrToMask(prefix);
  const network = (ipToLong(ip) & mask) >>> 0;
  const hosts   = [];
  const count   = (1 << (32 - prefix)) - 2; // exclude network + broadcast
  for (let i = 1; i <= Math.min(count, 254); i++) {
    hosts.push(longToIp(network + i));
  }
  return hosts;
}

// ── Network info ──────────────────────────────────────────────────────────────

function getLocalNetworkInfo() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of (addrs || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Prefer RFC-1918 addresses
      const ip = addr.address;
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        candidates.push({ name, ip, netmask: addr.netmask, cidr: addr.cidr });
      }
    }
  }

  if (candidates.length === 0) return null;

  const best = candidates[0];
  const prefix = best.cidr ? parseInt(best.cidr.split('/')[1], 10) : 24;

  return {
    interface: best.name,
    localIp:   best.ip,
    netmask:   best.netmask,
    prefix,
    cidr:      `${best.ip.split('.').slice(0, 3).join('.')}.0/${prefix}`
  };
}

async function getDefaultGateway() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('route print 0.0.0.0');
      const match = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } else {
      const { stdout } = await execAsync("ip route show default | awk '/default/ {print $3}' | head -1");
      return stdout.trim() || null;
    }
  } catch {
    return null;
  }
}

// ── OUI/Vendor lookup (bundled top-25 prefixes for zero-dep experience) ───────

const OUI_TABLE = {
  '00:50:56': 'VMware',       '00:0C:29': 'VMware',
  '00:1A:11': 'Google',       'B8:27:EB': 'Raspberry Pi',
  'DC:A6:32': 'Raspberry Pi', 'E4:5F:01': 'Raspberry Pi',
  '00:1B:63': 'Apple',        '3C:15:C2': 'Apple',
  'AC:BC:32': 'Apple',        '78:7B:8A': 'Apple',
  'B8:E8:56': 'Apple',        '28:CD:C1': 'Apple',
  'F0:18:98': 'Apple',        '00:1E:65': 'Apple',
  '34:36:3B': 'Apple',        '00:1C:B3': 'Apple',
  'FC:3F:DB': 'Samsung',      '30:CD:A7': 'Samsung',
  'CC:07:AB': 'Samsung',      '00:26:37': 'Samsung',
  '1C:62:B8': 'Samsung',      '44:4E:1A': 'Cisco',
  '00:1A:2B': 'Cisco',        '00:08:E3': 'Cisco',
  'A0:36:9F': 'Intel',        '8C:8D:28': 'Intel',
  '00:21:5A': 'Dell',         '54:BF:64': 'Dell',
  'E8:11:32': 'Huawei',       '00:E0:FC': 'Huawei',
  '28:31:52': 'Huawei',       'C4:86:E9': 'Huawei',
  'CC:96:A0': 'TP-Link',      'A0:F3:C1': 'TP-Link',
  '50:C7:BF': 'TP-Link',      '00:0F:66': 'D-Link',
  'F0:7D:68': 'D-Link',       '90:4D:4A': 'D-Link',
  '00:26:5A': 'Netgear',      'A0:21:B7': 'Netgear',
  '00:14:6C': 'Netgear',      '20:E5:2A': 'Espressif',
  'CC:50:E3': 'Espressif',    '30:AE:A4': 'Espressif',
  '00:17:88': 'Philips Hue',  '7C:49:EB': 'Philips Hue',
  'EC:FA:BC': 'Amazon',       'F0:81:73': 'Amazon',
  'B4:A9:FC': 'Google/Nest',  '54:60:09': 'Google/Nest',
  'F4:F5:DB': 'Google/Nest',  '94:65:9C': 'Google/Nest',
};

function lookupVendor(mac) {
  if (!mac) return 'Unknown';
  const prefix = mac.toUpperCase().substring(0, 8);
  return OUI_TABLE[prefix] || OUI_TABLE[mac.toUpperCase().substring(0, 5)] || 'Unknown';
}

// ── ARP table reader ──────────────────────────────────────────────────────────

async function readArpTable() {
  const entries = [];
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('arp -a');
      const re = /(\d+\.\d+\.\d+\.\d+)\s+([\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2})/g;
      let m;
      while ((m = re.exec(stdout)) !== null) {
        const mac = m[2].replace(/-/g, ':').toLowerCase();
        if (!mac.startsWith('ff:') && mac !== '00:00:00:00:00:00') {
          entries.push({ ip: m[1], mac, vendor: lookupVendor(mac) });
        }
      }
    } else {
      const { stdout } = await execAsync('arp -n 2>/dev/null || ip neigh show 2>/dev/null');
      const re = /(\d+\.\d+\.\d+\.\d+).*?([\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2})/g;
      let m;
      while ((m = re.exec(stdout)) !== null) {
        const mac = m[2].toLowerCase();
        if (!mac.startsWith('ff:') && mac !== '00:00:00:00:00:00') {
          entries.push({ ip: m[1], mac, vendor: lookupVendor(mac) });
        }
      }
    }
  } catch { /* arp may not be available */ }
  return entries;
}

// ── Ping sweep ────────────────────────────────────────────────────────────────

async function pingHost(ip) {
  try {
    const args = process.platform === 'win32'
      ? ['ping', '-n', '1', '-w', '500', ip]
      : ['ping', '-c', '1', '-W', '1', ip];
    const { stdout } = await execAsync(
      process.platform === 'win32'
        ? `ping -n 1 -w 500 ${ip}`
        : `ping -c 1 -W 1 ${ip}`,
      { timeout: 2000 }
    );
    return stdout.includes('TTL=') || stdout.includes('ttl=') ||
           stdout.includes('bytes from') || stdout.includes('1 received') ||
           stdout.includes('1 packets received');
  } catch {
    return false;
  }
}

async function pingSweep(hosts) {
  const CONCURRENCY = 20;
  const alive = [];
  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    const batch = hosts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (ip) => {
      const up = await pingHost(ip);
      return { ip, alive: up };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.alive) alive.push(r.value.ip);
    }
  }
  return alive;
}

// ── Hostname resolution ───────────────────────────────────────────────────────

async function resolveHostname(ip) {
  try {
    const dns = require('dns').promises;
    const hostnames = await dns.reverse(ip);
    return hostnames[0] || null;
  } catch {
    return null;
  }
}

// ── Device type guesser ───────────────────────────────────────────────────────

function guessDeviceType(device) {
  const v = (device.vendor || '').toLowerCase();
  const h = (device.hostname || '').toLowerCase();
  if (/router|gateway|tp-link|netgear|d-link|asus|linksys|ubiquiti|mikrotik/.test(v + h)) return 'router';
  if (/apple|iphone|ipad/.test(v + h)) return 'phone';
  if (/samsung|huawei|oneplus|xiaomi|oppo/.test(v)) return 'phone';
  if (/raspberry/.test(v)) return 'server';
  if (/vmware|virtual/.test(v)) return 'server';
  if (/dell|intel|hp|lenovo|asus|acer|msi/.test(v)) return 'desktop';
  if (/amazon|google|nest|philips/.test(v)) return 'iot';
  if (/espressif/.test(v)) return 'iot';
  if (/android|phone/.test(h)) return 'phone';
  if (/laptop|macbook|pc|desktop/.test(h)) return 'desktop';
  return 'unknown';
}

// ── Scan state ────────────────────────────────────────────────────────────────

let lastScanResult = null;
let scanInProgress = false;

async function runScan() {
  if (scanInProgress) {
    return { error: 'Scan already in progress', cached: lastScanResult };
  }
  scanInProgress = true;

  try {
    const netInfo = getLocalNetworkInfo();
    if (!netInfo) {
      return { error: 'No local RFC-1918 network interface found', devices: [] };
    }

    const gateway  = await getDefaultGateway();
    const hosts    = subnetHosts(netInfo.localIp, netInfo.prefix);
    const aliveIps = await pingSweep(hosts);
    const arpTable = await readArpTable();
    const arpMap   = new Map(arpTable.map((e) => [e.ip, e]));

    // Ensure local host is included
    if (!aliveIps.includes(netInfo.localIp)) aliveIps.unshift(netInfo.localIp);
    if (gateway && !aliveIps.includes(gateway)) aliveIps.unshift(gateway);

    const devices = await Promise.all(aliveIps.map(async (ip) => {
      const arp = arpMap.get(ip);
      const mac = arp ? arp.mac : null;
      const vendor = arp ? arp.vendor : 'Unknown';
      const hostname = await resolveHostname(ip);
      const isLocal  = ip === netInfo.localIp;
      const isGateway = ip === gateway;
      const type = isLocal ? 'this-device'
                 : isGateway ? 'router'
                 : guessDeviceType({ vendor, hostname });

      return {
        ip,
        mac: mac || 'Unavailable',
        vendor,
        hostname: hostname || null,
        type,
        isLocalDevice: isLocal,
        isGateway,
        lastSeen: Date.now(),
        status: 'online'
      };
    }));

    const result = {
      scannedAt:  Date.now(),
      localIp:    netInfo.localIp,
      cidr:       netInfo.cidr,
      gateway:    gateway || 'Unknown',
      deviceCount: devices.length,
      devices
    };

    lastScanResult = result;
    return result;
  } finally {
    scanInProgress = false;
  }
}

// ── CORS + JSON helpers ───────────────────────────────────────────────────────

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',          // localhost-only; safe
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  switch (url) {
    case '/': {
      const netInfo = getLocalNetworkInfo();
      return sendJson(res, 200, {
        service: 'NETWATCH Local Discovery Agent',
        version: VERSION,
        status: 'running',
        localIp: netInfo ? netInfo.localIp : null,
        platform: process.platform,
        nodeVersion: process.version
      });
    }

    case '/network': {
      const netInfo = getLocalNetworkInfo();
      const gateway = await getDefaultGateway();
      return sendJson(res, 200, {
        ...netInfo,
        gateway: gateway || 'Unknown',
        hostname: os.hostname()
      });
    }

    case '/scan': {
      const result = await runScan();
      return sendJson(res, result.error && !result.cached ? 500 : 200, result);
    }

    case '/devices': {
      if (!lastScanResult) {
        return sendJson(res, 200, { devices: [], message: 'No scan performed yet. Call /scan first.' });
      }
      return sendJson(res, 200, lastScanResult);
    }

    default:
      return sendJson(res, 404, { error: 'Unknown endpoint' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NETWATCH Local Discovery Agent v${VERSION}`);
  console.log(`Listening on http://${HOST}:${PORT}/`);
  console.log('Endpoints: / | /network | /scan | /devices');
  console.log('Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The agent may already be running.`);
  } else {
    console.error('Agent error:', err.message);
  }
  process.exit(1);
});
