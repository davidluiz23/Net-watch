#!/usr/bin/env node
/**
 * NETWATCH Local Discovery & Inspection Agent v2.0.0
 * ====================================================
 * Lightweight Node.js HTTP companion service for NETWATCH.
 *
 * MODES:
 *   Default (localhost-only):  node agent.js
 *     Binds strictly to 127.0.0.1:7779. Only the host machine can connect.
 *
 *   Secure LAN mode:           node agent.js --lan
 *     Allows authenticated devices on the SAME local RFC-1918 subnet
 *     (e.g. a phone on the same Wi-Fi) to connect using a randomly
 *     generated access token.
 *     - Rejects any client IP outside loopback / detected local subnet.
 *     - Requires Authorization: Bearer <token> or X-Netwatch-Token: <token>.
 *     - Never exposes LAN mode without authentication.
 *
 * SECURITY GUARANTEES:
 *   - All discovery & inspection targets are validated against the host's
 *     detected local RFC-1918 subnet (never scans external/internet IPs).
 *   - TCP port connectivity checks use a fixed, small allowlist of common
 *     local service ports with short timeouts.
 *   - No password guessing, no exploitation, no packet capture, no private
 *     traffic interception.
 *
 * REST API:
 *   GET /                         Health check & agent metadata
 *   GET /network                  Local IPv4, subnet CIDR, netmask, default gateway
 *   GET /scan                     ARP + ICMP ping sweep of local subnet (measures RTT)
 *   GET /devices                  Last cached scan + known offline devices & scan diff
 *   GET /inspect?ip=<ipv4>&ports=1 Live reachability, RTT, ARP/DNS, TCP port check, history
 *   GET /history                  Full device appearance/disappearance history
 *
 * Requires Node.js 18+ (built-in modules only — zero external dependencies).
 */

'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const dns = require('dns').promises;
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const VERSION = '2.0.0';
const HISTORY_FILE = path.join(__dirname, '.netwatch-device-history.json');

// ── CLI & Environment Configuration ──────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    lan: process.env.NETWATCH_LAN === '1' || process.env.NETWATCH_LAN === 'true',
    port: Number(process.env.NETWATCH_PORT) || 7779,
    token: process.env.NETWATCH_TOKEN || '',
    requireAuthLocal: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lan') {
      opts.lan = true;
    } else if (arg === '--require-auth-local') {
      opts.requireAuthLocal = true;
    } else if (arg === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isInteger(p) && p >= 1024 && p <= 65535) opts.port = p;
    } else if (arg === '--token' && argv[i + 1]) {
      opts.token = String(argv[++i]).trim();
    } else if (arg === '--help' || arg === '-h') {
      console.log(`NETWATCH Local Discovery Agent v${VERSION}
Usage:
  node agent.js                     Start in localhost-only mode (127.0.0.1:7779)
  node agent.js --lan               Start in secure LAN mode with random access token
  node agent.js --lan --port 7779   Custom port (1024-65535)
  node agent.js --lan --token <tok> Custom access token (min 16 characters)
  node agent.js --require-auth-local Require token even for 127.0.0.1 requests`);
      process.exit(0);
    }
  }

  return opts;
}

const CONFIG = parseArgs(process.argv);

// Generate a cryptographically secure random token when in LAN mode (or if requested)
let ACCESS_TOKEN = null;
if (CONFIG.lan || CONFIG.requireAuthLocal || CONFIG.token) {
  if (CONFIG.token) {
    if (CONFIG.token.length < 16) {
      console.error('Security Error: Custom --token must be at least 16 characters long.');
      process.exit(1);
    }
    ACCESS_TOKEN = CONFIG.token;
  } else {
    ACCESS_TOKEN = crypto.randomBytes(24).toString('base64url');
  }
}

const BIND_HOST = CONFIG.lan ? '0.0.0.0' : '127.0.0.1';
const BIND_PORT = CONFIG.port;

// ── IPv4 & Subnet Validation Helpers ─────────────────────────────────────────

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  return [m[1], m[2], m[3], m[4]].every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function longToIp(long) {
  return [(long >>> 24) & 255, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

function cidrToMask(prefix) {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff >>> 0;
  return (~0 << (32 - prefix)) >>> 0;
}

function isPrivateRfc1918(ip) {
  if (!isValidIpv4(ip)) return false;
  const long = ipToLong(ip);
  const a = (long >>> 24) & 255;
  const b = (long >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizeRemoteIp(remoteAddress) {
  if (!remoteAddress) return '';
  if (remoteAddress.startsWith('::ffff:')) return remoteAddress.slice(7);
  return remoteAddress;
}

function isLoopbackAddress(remoteAddress) {
  const ip = normalizeRemoteIp(remoteAddress);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function isIpInSubnet(ip, netInfo) {
  if (!isValidIpv4(ip) || !netInfo) return false;
  // Cap effective inspection prefix to at least /16 for safety
  const prefix = Math.max(16, Math.min(30, netInfo.prefix || 24));
  const mask = cidrToMask(prefix);
  const targetNet = (ipToLong(ip) & mask) >>> 0;
  const localNet = (ipToLong(netInfo.localIp) & mask) >>> 0;
  if (targetNet !== localNet) return false;

  // Reject network and broadcast addresses
  const broadcast = (localNet | (~mask >>> 0)) >>> 0;
  const targetLong = ipToLong(ip);
  return targetLong > localNet && targetLong < broadcast;
}

function subnetHosts(ip, prefix) {
  // Safety cap: always scan at most a /24 around the local IP (max 254 hosts)
  const effectivePrefix = prefix < 24 ? 24 : Math.min(30, prefix);
  const mask = cidrToMask(effectivePrefix);
  const network = (ipToLong(ip) & mask) >>> 0;
  const count = (1 << (32 - effectivePrefix)) - 2;
  const hosts = [];
  for (let i = 1; i <= Math.min(count, 254); i += 1) {
    hosts.push(longToIp((network + i) >>> 0));
  }
  return hosts;
}

// ── Network Interface & Gateway Detection ────────────────────────────────────

function getLocalNetworkInfo() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of (addrs || [])) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (!isPrivateRfc1918(addr.address)) continue;

      // Deprioritize virtual adapters (VMware, VirtualBox, WSL, Hyper-V, Docker)
      const lower = name.toLowerCase();
      const isVirtual = /vethernet|vmware|virtualbox|vbox|wsl|docker|hyper-v|loopback|tailscale|zerotier/.test(lower);
      const isWifiOrEth = /wi-fi|wifi|wlan|ethernet|en0|eth0/.test(lower);
      const score = (isWifiOrEth ? 10 : 0) - (isVirtual ? 20 : 0) + (addr.address.startsWith('192.168.') ? 3 : 1);

      candidates.push({
        name,
        ip: addr.address,
        mac: addr.mac && addr.mac !== '00:00:00:00:00:00' ? addr.mac.toLowerCase() : null,
        netmask: addr.netmask,
        cidr: addr.cidr,
        score
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const prefix = best.cidr && best.cidr.includes('/')
    ? parseInt(best.cidr.split('/')[1], 10)
    : 24;
  const mask = cidrToMask(prefix);
  const networkIp = longToIp((ipToLong(best.ip) & mask) >>> 0);

  return {
    interface: best.name,
    localIp: best.ip,
    localMac: best.mac,
    netmask: best.netmask,
    prefix,
    cidr: `${networkIp}/${prefix}`,
    allInterfaces: candidates.map((c) => ({ name: c.name, ip: c.ip, cidr: c.cidr }))
  };
}

async function getDefaultGateway() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('route print 0.0.0.0', { timeout: 3000 });
      const lines = stdout.split(/\r?\n/);
      let bestGw = null;
      let bestMetric = Infinity;
      for (const line of lines) {
        const m = line.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/);
        if (m && isValidIpv4(m[1])) {
          const metric = Number(m[3]);
          if (metric < bestMetric) {
            bestMetric = metric;
            bestGw = m[1];
          }
        }
      }
      if (bestGw) return bestGw;
      const fallback = stdout.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
      return fallback ? fallback[1] : null;
    } else {
      const { stdout } = await execAsync("ip route show default | awk '/default/ {print $3}' | head -1", { timeout: 3000 });
      const gw = stdout.trim();
      return isValidIpv4(gw) ? gw : null;
    }
  } catch {
    return null;
  }
}

// ── MAC OUI Manufacturer / Vendor Lookup ─────────────────────────────────────
// Bundled common OUI prefixes (IEEE 24-bit MA-L). Unknown OUIs return 'Unknown'.

const OUI_TABLE = {
  // Apple
  '00:1B:63': 'Apple', '00:1C:B3': 'Apple', '00:1E:65': 'Apple', '00:25:00': 'Apple',
  '28:CD:C1': 'Apple', '34:36:3B': 'Apple', '3C:15:C2': 'Apple', '40:A6:D9': 'Apple',
  '5C:F9:38': 'Apple', '70:56:81': 'Apple', '78:7B:8A': 'Apple', '88:66:A5': 'Apple',
  'A4:83:E7': 'Apple', 'AC:BC:32': 'Apple', 'B8:E8:56': 'Apple', 'C8:2A:14': 'Apple',
  'D0:81:7A': 'Apple', 'DC:2B:2A': 'Apple', 'F0:18:98': 'Apple', 'F4:5C:89': 'Apple',
  // Samsung
  '00:26:37': 'Samsung', '1C:62:B8': 'Samsung', '30:CD:A7': 'Samsung', '34:23:BA': 'Samsung',
  '50:01:BB': 'Samsung', '78:47:1D': 'Samsung', '84:25:DB': 'Samsung', 'A0:82:1F': 'Samsung',
  'BC:72:B1': 'Samsung', 'CC:07:AB': 'Samsung', 'D0:22:BE': 'Samsung', 'FC:3F:DB': 'Samsung',
  // Google / Nest
  '00:1A:11': 'Google', '3C:5A:B4': 'Google', '54:60:09': 'Google / Nest',
  '94:65:9C': 'Google / Nest', 'B4:A9:FC': 'Google / Nest', 'D8:6C:63': 'Google',
  'F4:F5:DB': 'Google / Nest', 'F8:8F:CA': 'Google',
  // Intel / PCs / Laptops
  '00:1B:21': 'Intel', '34:13:E8': 'Intel', '3C:97:0E': 'Lenovo', '48:51:B7': 'Intel',
  '68:05:CA': 'Intel', '7C:7A:91': 'Intel', '8C:8D:28': 'Intel', 'A0:36:9F': 'Intel',
  'A4:4C:C8': 'Dell', 'B4:B6:86': 'Intel', 'C8:5B:76': 'Lenovo', 'D4:3B:04': 'Intel',
  '00:21:5A': 'HP', '3C:D9:2B': 'HP', '54:BF:64': 'Dell', 'D4:BE:D9': 'Dell',
  '00:14:22': 'Dell', '18:66:DA': 'Dell', 'F8:BC:12': 'Dell', '98:FA:9B': 'Lenovo',
  '00:50:F2': 'Microsoft', '28:18:78': 'Microsoft', '7C:1E:52': 'Microsoft',
  '00:E0:4C': 'Realtek', '52:54:00': 'QEMU / KVM', '00:15:5D': 'Microsoft Hyper-V',
  // Routers & Networking
  '00:08:E3': 'Cisco', '00:1A:2B': 'Cisco', '44:4E:1A': 'Cisco', '68:BD:AB': 'Cisco',
  '50:C7:BF': 'TP-Link', 'A0:F3:C1': 'TP-Link', 'B0:BE:76': 'TP-Link', 'C0:25:E9': 'TP-Link',
  'CC:96:A0': 'TP-Link', 'D8:0D:17': 'TP-Link', 'E8:DE:27': 'TP-Link', 'F4:F2:6D': 'TP-Link',
  '00:0F:66': 'D-Link', '90:4D:4A': 'D-Link', 'F0:7D:68': 'D-Link',
  '00:14:6C': 'Netgear', '00:26:5A': 'Netgear', 'A0:21:B7': 'Netgear', 'C0:3F:0E': 'Netgear',
  '04:18:D6': 'Ubiquiti', '18:E8:29': 'Ubiquiti', '24:A4:3C': 'Ubiquiti', '78:8A:20': 'Ubiquiti',
  '80:2A:A8': 'Ubiquiti', 'FC:EC:DA': 'Ubiquiti', '4C:5E:0C': 'MikroTik', '64:D1:54': 'MikroTik',
  '04:D9:F5': 'ASUS', '10:BF:48': 'ASUS', '2C:56:DC': 'ASUS', 'AC:22:0B': 'ASUS',
  '00:18:F8': 'Linksys', '20:AA:4B': 'Linksys', 'C0:56:27': 'Linksys',
  // Mobile Vendors
  '00:E0:FC': 'Huawei', '28:31:52': 'Huawei', 'C4:86:E9': 'Huawei', 'E8:11:32': 'Huawei',
  '64:09:80': 'Xiaomi', '78:11:DC': 'Xiaomi', '8C:BE:BE': 'Xiaomi', 'F8:A4:5F': 'Xiaomi',
  '94:65:2D': 'OnePlus', 'C0:EE:FB': 'OnePlus', '00:23:76': 'HTC',
  // SBC / Servers / NAS / Virtual
  'B8:27:EB': 'Raspberry Pi', 'DC:A6:32': 'Raspberry Pi', 'E4:5F:01': 'Raspberry Pi', '28:CD:C1': 'Raspberry Pi',
  '00:11:32': 'Synology', '00:08:9B': 'QNAP',
  '00:0C:29': 'VMware', '00:50:56': 'VMware', '08:00:27': 'VirtualBox',
  // IoT / Smart Home / Media / Printers
  '20:E5:2A': 'Espressif (IoT)', '30:AE:A4': 'Espressif (IoT)', 'CC:50:E3': 'Espressif (IoT)',
  '00:17:88': 'Philips Hue', '7C:49:EB': 'Philips Hue',
  'EC:FA:BC': 'Amazon', 'F0:81:73': 'Amazon', '44:65:0D': 'Amazon', '74:C2:46': 'Amazon',
  '00:0E:58': 'Sonos', 'B8:E9:37': 'Sonos', 'B0:A7:37': 'Roku', 'D8:31:34': 'Roku',
  '00:1E:C2': 'Apple', '00:04:4B': 'NVIDIA', '00:24:8D': 'Sony', 'FC:0F:E6': 'Sony',
  '00:1B:A9': 'Brother', '00:26:AB': 'Epson', '00:1E:8F': 'Canon'
};

function isLocallyAdministeredMac(mac) {
  if (!mac || typeof mac !== 'string') return false;
  const firstOctet = parseInt(mac.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return false;
  // Bit 1 (0x02) of first octet indicates Locally Administered Address (randomized mobile MAC)
  return (firstOctet & 0x02) !== 0;
}

function lookupVendor(mac) {
  if (!mac || mac === 'Unavailable') {
    return { vendor: 'Unavailable', randomizedMac: false };
  }
  const normalized = mac.toUpperCase().replace(/-/g, ':');
  const prefix = normalized.slice(0, 8);
  const found = OUI_TABLE[prefix];
  if (found) return { vendor: found, randomizedMac: false };
  if (isLocallyAdministeredMac(normalized)) {
    return { vendor: 'Unknown (Randomized / Private MAC)', randomizedMac: true };
  }
  return { vendor: 'Unknown', randomizedMac: false };
}

// ── ARP Table Reader ──────────────────────────────────────────────────────────

async function readArpTable() {
  const entries = [];
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('arp -a', { timeout: 5000 });
      const re = /(\d+\.\d+\.\d+\.\d+)\s+([\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2}[-:][\da-fA-F]{2})/g;
      let m;
      while ((m = re.exec(stdout)) !== null) {
        const ip = m[1];
        const mac = m[2].replace(/-/g, ':').toLowerCase();
        if (isValidIpv4(ip) && !mac.startsWith('ff:') && mac !== '00:00:00:00:00:00') {
          const { vendor, randomizedMac } = lookupVendor(mac);
          entries.push({ ip, mac, vendor, randomizedMac });
        }
      }
    } else {
      const { stdout } = await execAsync('arp -n 2>/dev/null || ip neigh show 2>/dev/null', { timeout: 5000 });
      const re = /(\d+\.\d+\.\d+\.\d+).*?([\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2}:[\da-fA-F]{2})/g;
      let m;
      while ((m = re.exec(stdout)) !== null) {
        const ip = m[1];
        const mac = m[2].toLowerCase();
        if (isValidIpv4(ip) && !mac.startsWith('ff:') && mac !== '00:00:00:00:00:00') {
          const { vendor, randomizedMac } = lookupVendor(mac);
          entries.push({ ip, mac, vendor, randomizedMac });
        }
      }
    }
  } catch {
    // ARP command unavailable or restricted
  }
  return entries;
}

// ── ICMP Ping & RTT Measurement ──────────────────────────────────────────────

function parsePingRtt(stdout) {
  if (!stdout) return null;
  // Windows: time=4ms, time<1ms, temps=4 ms, Zeit=4ms
  const ltMatch = stdout.match(/(?:time|temps|zeit)\s*<\s*1\s*ms/i);
  if (ltMatch) return 0.5;
  const msMatch = stdout.match(/(?:time|temps|zeit)[=:]\s*([\d.]+)\s*ms/i);
  if (msMatch) {
    const v = Number(msMatch[1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

async function pingHost(ip, count = 1, timeoutMs = 500) {
  if (!isValidIpv4(ip)) return { alive: false, rttMs: null, samples: [] };
  try {
    const args = process.platform === 'win32'
      ? ['-n', String(count), '-w', String(timeoutMs), ip]
      : ['-c', String(count), '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];

    const { stdout } = await execFileAsync('ping', args, { timeout: Math.max(2000, count * (timeoutMs + 800)) });
    const alive = /TTL=/i.test(stdout) || /bytes from/i.test(stdout) || /[1-9]\s+(?:packets\s+)?received/i.test(stdout);

    // Extract individual RTT samples
    const samples = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (/TTL=/i.test(line) || /bytes from/i.test(line)) {
        const rtt = parsePingRtt(line);
        if (rtt !== null) samples.push(rtt);
      }
    }
    const rttMs = samples.length > 0
      ? Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2))
      : null;

    return { alive, rttMs, samples };
  } catch (err) {
    // Partial replies may still exist in stdout if some pings failed
    const stdout = err && err.stdout ? String(err.stdout) : '';
    const alive = /TTL=/i.test(stdout) || /bytes from/i.test(stdout);
    const rttMs = alive ? parsePingRtt(stdout) : null;
    return { alive, rttMs, samples: rttMs !== null ? [rttMs] : [] };
  }
}

async function windowsFastPingSweep(hosts, timeoutMs = 300) {
  // Single PowerShell process firing all 254 ICMP requests concurrently via .NET SendPingAsync
  const listLiteral = hosts.map((ip) => `'${ip}'`).join(',');
  const psScript = [
    `$ips = @(${listLiteral})`,
    `$items = foreach ($ip in $ips) { $p = New-Object System.Net.NetworkInformation.Ping; [PSCustomObject]@{ IP = $ip; Task = $p.SendPingAsync($ip, ${timeoutMs}); Ping = $p } }`,
    `try { [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]($items.Task), ${timeoutMs + 2500}) | Out-Null } catch {}`,
    `foreach ($it in $items) { if ($it.Task.IsCompleted -and -not $it.Task.IsFaulted -and $it.Task.Result.Status -eq 'Success') { Write-Output ($it.IP + '=' + $it.Task.Result.RoundtripTime) }; $it.Ping.Dispose() }`
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { timeout: timeoutMs + 5000 }
  );

  const aliveMap = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)=([\d.]+)$/);
    if (m && isValidIpv4(m[1])) {
      const rtt = Number(m[2]);
      aliveMap.set(m[1], Number.isFinite(rtt) ? (rtt === 0 ? 0.5 : rtt) : null);
    }
  }
  return aliveMap;
}

async function pingSweep(hosts) {
  // Fast path on Windows: all hosts pinged concurrently inside one .NET async batch (~1.5-2.5s total)
  if (process.platform === 'win32' && hosts.length > 0) {
    try {
      return await windowsFastPingSweep(hosts, 300);
    } catch {
      // Fall back to high-concurrency ping processes
    }
  }

  const CONCURRENCY = 64;
  const aliveMap = new Map();
  for (let i = 0; i < hosts.length; i += CONCURRENCY) {
    const batch = hosts.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (ip) => ({ ip, ...(await pingHost(ip, 1, 250)) }))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.alive) {
        aliveMap.set(r.value.ip, r.value.rttMs);
      }
    }
  }
  return aliveMap;
}

// ── Authorized Limited TCP Connectivity Check ────────────────────────────────

const COMMON_LAN_PORTS = [
  { port: 22, service: 'SSH' },
  { port: 53, service: 'DNS' },
  { port: 80, service: 'HTTP' },
  { port: 443, service: 'HTTPS' },
  { port: 445, service: 'SMB (File Sharing)' },
  { port: 548, service: 'AFP (Apple Filing)' },
  { port: 554, service: 'RTSP (Media Stream)' },
  { port: 3389, service: 'RDP (Remote Desktop)' },
  { port: 5000, service: 'HTTP-Alt / UPnP' },
  { port: 8080, service: 'HTTP-Alt' },
  { port: 8443, service: 'HTTPS-Alt' },
  { port: 9100, service: 'JetDirect (Printer)' }
];

function checkTcpPort(ip, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const t0 = process.hrtime.bigint();
    let settled = false;

    const finish = (open) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      socket.destroy();
      resolve({ port, open, rttMs: open ? Number(elapsedMs.toFixed(1)) : null });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, ip);
    } catch {
      finish(false);
    }
  });
}

async function checkCommonPorts(ip) {
  const results = await Promise.all(
    COMMON_LAN_PORTS.map(async (entry) => {
      const probe = await checkTcpPort(ip, entry.port, 600);
      return { port: entry.port, service: entry.service, open: probe.open, rttMs: probe.rttMs };
    })
  );
  const openPorts = results.filter((r) => r.open);
  return {
    checkedCount: COMMON_LAN_PORTS.length,
    openPorts,
    checkedAt: Date.now()
  };
}

// ── Hostname Resolution ───────────────────────────────────────────────────────

async function resolveHostname(ip) {
  try {
    const hostnames = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
    ]);
    return Array.isArray(hostnames) && hostnames[0] ? hostnames[0] : null;
  } catch {
    return null;
  }
}

// ── Device Type Estimation (Clearly Flagged as Estimated) ────────────────────

function guessDeviceType({ vendor, hostname, randomizedMac }) {
  const v = (vendor || '').toLowerCase();
  const h = (hostname || '').toLowerCase();

  if (/router|gateway|tp-link|netgear|d-link|linksys|ubiquiti|mikrotik|cisco/.test(v) || /router|gateway|modem/.test(h)) {
    return { type: 'router', estimated: true, reason: 'OUI vendor / hostname heuristic' };
  }
  if (/iphone|ipad|android|pixel|galaxy|phone/.test(h)) {
    return { type: 'phone', estimated: true, reason: 'Hostname heuristic' };
  }
  if (/macbook|laptop|thinkpad|desktop|workstation|-pc\b/.test(h)) {
    return { type: 'desktop', estimated: true, reason: 'Hostname heuristic' };
  }
  if (/samsung|huawei|oneplus|xiaomi/.test(v)) {
    return { type: 'phone', estimated: true, reason: 'OUI vendor heuristic (mobile manufacturer)' };
  }
  if (/apple/.test(v)) {
    return { type: 'phone', estimated: true, reason: 'OUI vendor heuristic (Apple device — phone/tablet/Mac)' };
  }
  if (/raspberry|synology|qnap|vmware|virtualbox|qemu|hyper-v/.test(v)) {
    return { type: 'server', estimated: true, reason: 'OUI vendor heuristic (server/NAS/VM)' };
  }
  if (/dell|intel|hp|lenovo|asus|microsoft|realtek/.test(v)) {
    return { type: 'desktop', estimated: true, reason: 'OUI vendor heuristic (PC/NIC manufacturer)' };
  }
  if (/espressif|philips|amazon|nest|sonos|roku|brother|epson|canon/.test(v)) {
    return { type: 'iot', estimated: true, reason: 'OUI vendor heuristic (IoT/smart device/printer)' };
  }
  if (randomizedMac) {
    return { type: 'phone', estimated: true, reason: 'Locally administered (randomized) MAC — commonly phones/modern OS' };
  }
  return { type: 'unknown', estimated: true, reason: 'Insufficient evidence to classify' };
}

// ── Persistent Device History Store ──────────────────────────────────────────

let deviceHistory = new Map(); // key (MAC or ip:<ip>) -> record
let scanHistoryLog = [];       // recent scan diff summaries
let lastScanResult = null;
let lastSuccessfulScanAt = null;
let scanInProgress = false;

function loadHistoryFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (raw && Array.isArray(raw.devices)) {
      deviceHistory = new Map(raw.devices.map((d) => [d.key, d]));
    }
    if (raw && Array.isArray(raw.scanLog)) {
      scanHistoryLog = raw.scanLog.slice(0, 50);
    }
    if (raw && raw.lastSuccessfulScanAt) {
      lastSuccessfulScanAt = raw.lastSuccessfulScanAt;
    }
  } catch {
    // Ignore corrupted history file and start clean
  }
}

function saveHistoryToDisk() {
  try {
    const payload = {
      version: VERSION,
      lastSuccessfulScanAt,
      devices: Array.from(deviceHistory.values()),
      scanLog: scanHistoryLog.slice(0, 50)
    };
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {
    // Read-only filesystem — keep history in memory only
  }
}

function getDeviceKey(mac, ip) {
  return (mac && mac !== 'Unavailable') ? `mac:${mac.toLowerCase()}` : `ip:${ip}`;
}

function recordDeviceEvent(rec, type, detail, timestamp) {
  if (!Array.isArray(rec.events)) rec.events = [];
  rec.events.unshift({ type, detail, timestamp });
  if (rec.events.length > 30) rec.events.length = 30;
}

loadHistoryFromDisk();

// ── Network Discovery Scan ────────────────────────────────────────────────────

async function runScan() {
  if (scanInProgress) {
    return { error: 'Scan already in progress', cached: lastScanResult };
  }
  scanInProgress = true;

  try {
    const scanStartedAt = Date.now();
    const netInfo = getLocalNetworkInfo();
    if (!netInfo) {
      return { error: 'No local RFC-1918 network interface found', devices: [] };
    }

    const hosts = subnetHosts(netInfo.localIp, netInfo.prefix);
    const [gateway, aliveMap] = await Promise.all([
      getDefaultGateway(),
      pingSweep(hosts)
    ]);
    const arpTable = await readArpTable();
    const arpMap = new Map(arpTable.map((e) => [e.ip, e]));

    // Include local host, gateway, and any ARP neighbor inside the detected local subnet
    const discoveredIps = new Set(aliveMap.keys());
    discoveredIps.add(netInfo.localIp);
    if (gateway && isIpInSubnet(gateway, netInfo)) discoveredIps.add(gateway);
    for (const entry of arpTable) {
      if (isIpInSubnet(entry.ip, netInfo)) discoveredIps.add(entry.ip);
    }

    const now = Date.now();
    const seenKeysThisScan = new Set();
    const changes = { appeared: [], disappeared: [], returned: [] };

    const onlineDevices = await Promise.all(
      Array.from(discoveredIps).map(async (ip) => {
        const arp = arpMap.get(ip);
        const isLocal = ip === netInfo.localIp;
        const isGateway = ip === gateway;
        const mac = isLocal && netInfo.localMac ? netInfo.localMac : (arp ? arp.mac : null);
        const vendorInfo = lookupVendor(mac || 'Unavailable');
        const hostname = isLocal ? os.hostname() : await resolveHostname(ip);
        const rttMs = aliveMap.has(ip) ? aliveMap.get(ip) : (isLocal ? 0 : null);

        let typeInfo;
        if (isLocal) {
          typeInfo = { type: 'this-device', estimated: false, reason: 'Host running NETWATCH Agent' };
        } else if (isGateway) {
          typeInfo = { type: 'router', estimated: false, reason: 'Confirmed OS default gateway' };
        } else {
          typeInfo = guessDeviceType({ vendor: vendorInfo.vendor, hostname, randomizedMac: vendorInfo.randomizedMac });
        }

        const key = getDeviceKey(mac, ip);
        seenKeysThisScan.add(key);

        let hist = deviceHistory.get(key);
        // Also check if this IP was previously tracked under an ip:<ip> key before MAC was known
        if (!hist && mac) {
          const ipFallback = deviceHistory.get(`ip:${ip}`);
          if (ipFallback) {
            deviceHistory.delete(`ip:${ip}`);
            hist = { ...ipFallback, key };
            deviceHistory.set(key, hist);
          }
        }

        if (!hist) {
          hist = {
            key,
            ip,
            mac: mac || 'Unavailable',
            vendor: vendorInfo.vendor,
            randomizedMac: vendorInfo.randomizedMac,
            hostname: hostname || null,
            type: typeInfo.type,
            typeEstimated: typeInfo.estimated,
            typeReason: typeInfo.reason,
            isLocalDevice: isLocal,
            isGateway,
            firstDiscovered: now,
            lastSeen: now,
            lastOfflineAt: null,
            seenCount: 1,
            lastRttMs: rttMs,
            status: 'online',
            events: []
          };
          recordDeviceEvent(hist, 'appeared', `First discovered at ${ip}`, now);
          deviceHistory.set(key, hist);
          changes.appeared.push({ ip, mac: hist.mac, hostname: hist.hostname, vendor: hist.vendor });
        } else {
          const wasOffline = hist.status === 'offline';
          if (hist.ip !== ip) {
            recordDeviceEvent(hist, 'ip_changed', `IP changed from ${hist.ip} to ${ip}`, now);
          }
          if (wasOffline) {
            recordDeviceEvent(hist, 'returned', `Returned online at ${ip}`, now);
            changes.returned.push({ ip, mac: mac || hist.mac, hostname: hostname || hist.hostname, vendor: vendorInfo.vendor });
          }
          hist.ip = ip;
          if (mac) hist.mac = mac;
          if (vendorInfo.vendor !== 'Unavailable') {
            hist.vendor = vendorInfo.vendor;
            hist.randomizedMac = vendorInfo.randomizedMac;
          }
          if (hostname) hist.hostname = hostname;
          hist.type = typeInfo.type;
          hist.typeEstimated = typeInfo.estimated;
          hist.typeReason = typeInfo.reason;
          hist.isLocalDevice = isLocal;
          hist.isGateway = isGateway;
          hist.lastSeen = now;
          hist.seenCount = (hist.seenCount || 0) + 1;
          hist.lastRttMs = rttMs;
          hist.status = 'online';
        }

        return {
          key: hist.key,
          ip: hist.ip,
          mac: hist.mac,
          vendor: hist.vendor,
          randomizedMac: hist.randomizedMac,
          hostname: hist.hostname,
          type: hist.type,
          typeEstimated: hist.typeEstimated,
          typeReason: hist.typeReason,
          isLocalDevice: hist.isLocalDevice,
          isGateway: hist.isGateway,
          firstDiscovered: hist.firstDiscovered,
          lastSeen: hist.lastSeen,
          seenCount: hist.seenCount,
          rttMs: hist.lastRttMs,
          status: 'online',
          gateway: gateway || 'Unavailable',
          subnet: netInfo.cidr,
          events: hist.events.slice(0, 10)
        };
      })
    );

    // Mark previously known devices on this subnet that did not respond as offline
    const offlineDevices = [];
    for (const hist of deviceHistory.values()) {
      if (!seenKeysThisScan.has(hist.key)) {
        if (hist.status !== 'offline') {
          hist.status = 'offline';
          hist.lastOfflineAt = now;
          recordDeviceEvent(hist, 'disappeared', `No longer responding at ${hist.ip}`, now);
          changes.disappeared.push({ ip: hist.ip, mac: hist.mac, hostname: hist.hostname, vendor: hist.vendor });
        }
        offlineDevices.push({
          key: hist.key,
          ip: hist.ip,
          mac: hist.mac,
          vendor: hist.vendor,
          randomizedMac: Boolean(hist.randomizedMac),
          hostname: hist.hostname,
          type: hist.type,
          typeEstimated: hist.typeEstimated !== false,
          typeReason: hist.typeReason || 'Previously discovered',
          isLocalDevice: false,
          isGateway: Boolean(hist.isGateway),
          firstDiscovered: hist.firstDiscovered,
          lastSeen: hist.lastSeen,
          lastOfflineAt: hist.lastOfflineAt,
          seenCount: hist.seenCount || 1,
          rttMs: null,
          status: 'offline',
          gateway: gateway || 'Unavailable',
          subnet: netInfo.cidr,
          events: (hist.events || []).slice(0, 10)
        });
      }
    }

    lastSuccessfulScanAt = now;
    if (changes.appeared.length || changes.disappeared.length || changes.returned.length) {
      scanHistoryLog.unshift({ timestamp: now, ...changes });
      if (scanHistoryLog.length > 50) scanHistoryLog.length = 50;
    }
    saveHistoryToDisk();

    // Sort online devices: local first, gateway second, then by IP
    onlineDevices.sort((a, b) => {
      if (a.isLocalDevice) return -1;
      if (b.isLocalDevice) return 1;
      if (a.isGateway) return -1;
      if (b.isGateway) return 1;
      return ipToLong(a.ip) - ipToLong(b.ip);
    });

    const result = {
      scannedAt: now,
      scanDurationMs: Date.now() - scanStartedAt,
      lastSuccessfulScanAt,
      localIp: netInfo.localIp,
      cidr: netInfo.cidr,
      netmask: netInfo.netmask,
      gateway: gateway || 'Unavailable',
      deviceCount: onlineDevices.length,
      offlineCount: offlineDevices.length,
      devices: onlineDevices,
      offlineDevices,
      changes,
      incompleteNote: 'Devices with firewalls blocking ICMP or using AP client isolation may not appear.'
    };

    lastScanResult = result;
    return result;
  } finally {
    scanInProgress = false;
  }
}

// ── Deep Device Inspection (Single Validated Local IP) ───────────────────────

async function inspectDevice(targetIp, includePorts = true) {
  if (!isValidIpv4(targetIp)) {
    return { statusCode: 400, body: { error: 'Invalid IPv4 address format.' } };
  }

  const netInfo = getLocalNetworkInfo();
  if (!netInfo) {
    return { statusCode: 500, body: { error: 'No local RFC-1918 network interface detected.' } };
  }

  if (!isIpInSubnet(targetIp, netInfo)) {
    return {
      statusCode: 403,
      body: {
        error: `Target ${targetIp} is outside your detected local subnet (${netInfo.cidr}). Only local network devices may be inspected.`
      }
    };
  }

  const gateway = await getDefaultGateway();
  const isLocal = targetIp === netInfo.localIp;
  const isGateway = targetIp === gateway;

  // 1. Live reachability & RTT (3 pings for actual min/avg/max)
  const ping = await pingHost(targetIp, 3, 600);

  // 2. ARP lookup + Reverse DNS + Optional limited TCP port check (in parallel)
  const [arpTable, hostname, portCheck] = await Promise.all([
    readArpTable(),
    isLocal ? Promise.resolve(os.hostname()) : resolveHostname(targetIp),
    includePorts ? checkCommonPorts(targetIp) : Promise.resolve(null)
  ]);

  const arp = arpTable.find((e) => e.ip === targetIp);
  const mac = isLocal && netInfo.localMac ? netInfo.localMac : (arp ? arp.mac : null);
  const vendorInfo = lookupVendor(mac || 'Unavailable');

  let typeInfo;
  if (isLocal) {
    typeInfo = { type: 'this-device', estimated: false, reason: 'Host running NETWATCH Agent' };
  } else if (isGateway) {
    typeInfo = { type: 'router', estimated: false, reason: 'Confirmed OS default gateway' };
  } else {
    typeInfo = guessDeviceType({ vendor: vendorInfo.vendor, hostname, randomizedMac: vendorInfo.randomizedMac });
  }

  const now = Date.now();
  const key = getDeviceKey(mac, targetIp);
  let hist = deviceHistory.get(key) || Array.from(deviceHistory.values()).find((d) => d.ip === targetIp);

  const reachable = ping.alive || (portCheck && portCheck.openPorts.length > 0) || isLocal;
  const minRttMs = ping.samples.length ? Math.min(...ping.samples) : null;
  const maxRttMs = ping.samples.length ? Math.max(...ping.samples) : null;

  if (hist) {
    if (reachable) {
      if (hist.status === 'offline') {
        recordDeviceEvent(hist, 'returned', `Confirmed reachable during inspection at ${targetIp}`, now);
      }
      hist.status = 'online';
      hist.lastSeen = now;
      hist.lastRttMs = ping.rttMs;
    } else if (!isLocal) {
      if (hist.status !== 'offline') {
        recordDeviceEvent(hist, 'disappeared', `Unreachable during live inspection at ${targetIp}`, now);
      }
      hist.status = 'offline';
      hist.lastOfflineAt = now;
    }
    if (mac) hist.mac = mac;
    if (hostname) hist.hostname = hostname;
    saveHistoryToDisk();
  }

  return {
    statusCode: 200,
    body: {
      inspectedAt: now,
      ip: targetIp,
      mac: mac || (hist ? hist.mac : 'Unavailable'),
      vendor: vendorInfo.vendor !== 'Unavailable' ? vendorInfo.vendor : (hist ? hist.vendor : 'Unknown'),
      randomizedMac: vendorInfo.randomizedMac,
      hostname: hostname || (hist ? hist.hostname : null),
      type: typeInfo.type,
      typeEstimated: typeInfo.estimated,
      typeReason: typeInfo.reason,
      isLocalDevice: isLocal,
      isGateway,
      status: reachable ? 'online' : 'offline',
      reachability: {
        reachable,
        icmpAlive: ping.alive,
        probesSent: 3,
        probesReceived: ping.samples.length,
        avgRttMs: ping.rttMs,
        minRttMs,
        maxRttMs,
        samples: ping.samples
      },
      ports: portCheck,
      network: {
        subnet: netInfo.cidr,
        netmask: netInfo.netmask,
        gateway: gateway || 'Unavailable',
        hostInterface: netInfo.interface
      },
      history: hist ? {
        firstDiscovered: hist.firstDiscovered,
        lastSeen: hist.lastSeen,
        lastOfflineAt: hist.lastOfflineAt || null,
        seenCount: hist.seenCount || 1,
        events: (hist.events || []).slice(0, 20)
      } : {
        firstDiscovered: now,
        lastSeen: reachable ? now : null,
        lastOfflineAt: reachable ? null : now,
        seenCount: reachable ? 1 : 0,
        events: []
      },
      lastSuccessfulScanAt,
      provenanceNotes: [
        'OS and hardware model are not claimed without reliable evidence.',
        'Device type is estimated from MAC OUI / hostname unless marked as local host or default gateway.',
        'TCP port checks only test a fixed allowlist of common local service ports for connectivity.'
      ]
    }
  };
}

// ── Security: Client IP & Token Verification ─────────────────────────────────

function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers['x-netwatch-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return '';
}

function isTokenValid(provided) {
  if (!ACCESS_TOKEN || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(ACCESS_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAllowedClient(req, netInfo) {
  const remote = req.socket.remoteAddress || '';
  if (isLoopbackAddress(remote)) return { allowed: true, isLoopback: true, clientIp: normalizeRemoteIp(remote) };
  if (!CONFIG.lan) return { allowed: false, isLoopback: false, clientIp: normalizeRemoteIp(remote) };
  const clientIp = normalizeRemoteIp(remote);
  if (netInfo && isIpInSubnet(clientIp, netInfo)) {
    return { allowed: true, isLoopback: false, clientIp };
  }
  return { allowed: false, isLoopback: false, clientIp };
}

// ── CORS + JSON Helpers ──────────────────────────────────────────────────────

function buildCorsHeaders(req) {
  const origin = req.headers.origin || '*';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Netwatch-Token, Content-Type',
    'Cache-Control': 'no-store'
  };
  if (req.headers['access-control-request-private-network'] === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function sendJson(req, res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...buildCorsHeaders(req)
  });
  res.end(body);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const netInfo = getLocalNetworkInfo();
  const clientCheck = isAllowedClient(req, netInfo);

  // Handle CORS preflight (still verify client is on local network)
  if (req.method === 'OPTIONS') {
    if (!clientCheck.allowed) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(204, buildCorsHeaders(req));
    return res.end();
  }

  if (!clientCheck.allowed) {
    return sendJson(req, res, 403, {
      error: 'Access denied. NETWATCH Agent only accepts requests from the local network.'
    });
  }

  if (req.method !== 'GET') {
    return sendJson(req, res, 405, { error: 'Method not allowed. Only GET is supported.' });
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  const authRequiredForRequest = Boolean(ACCESS_TOKEN) && (!clientCheck.isLoopback || CONFIG.requireAuthLocal);
  const providedToken = extractToken(req);
  const authenticated = !authRequiredForRequest || isTokenValid(providedToken);

  // Root health endpoint: returns minimal safe status if unauthenticated LAN client
  if (pathname === '/') {
    if (!authenticated) {
      return sendJson(req, res, 200, {
        service: 'NETWATCH Local Discovery Agent',
        version: VERSION,
        status: 'running',
        mode: CONFIG.lan ? 'lan' : 'localhost',
        authRequired: true,
        authenticated: false
      });
    }

    const gateway = await getDefaultGateway();
    return sendJson(req, res, 200, {
      service: 'NETWATCH Local Discovery Agent',
      version: VERSION,
      status: 'running',
      mode: CONFIG.lan ? 'lan' : 'localhost',
      authRequired: Boolean(ACCESS_TOKEN),
      authenticated: true,
      port: BIND_PORT,
      localIp: netInfo ? netInfo.localIp : null,
      cidr: netInfo ? netInfo.cidr : null,
      gateway: gateway || null,
      platform: process.platform,
      nodeVersion: process.version,
      lastSuccessfulScanAt
    });
  }

  // Enforce authentication on all other endpoints
  if (!authenticated) {
    return sendJson(req, res, 401, {
      error: 'Authentication required. Provide a valid access token via Authorization: Bearer <token> or X-Netwatch-Token header.',
      authRequired: true
    });
  }

  try {
    if (pathname === '/network') {
      const gateway = await getDefaultGateway();
      return sendJson(req, res, 200, {
        ...(netInfo || {}),
        gateway: gateway || 'Unavailable',
        hostname: os.hostname(),
        mode: CONFIG.lan ? 'lan' : 'localhost',
        port: BIND_PORT
      });
    }

    if (pathname === '/scan') {
      const result = await runScan();
      return sendJson(req, res, result.error && !result.cached ? 500 : 200, result);
    }

    if (pathname === '/devices') {
      if (!lastScanResult) {
        // Return any persisted historical devices as offline until a fresh scan runs
        const persisted = Array.from(deviceHistory.values()).map((h) => ({
          ...h,
          status: 'offline',
          rttMs: null
        }));
        return sendJson(req, res, 200, {
          devices: [],
          offlineDevices: persisted,
          deviceCount: 0,
          offlineCount: persisted.length,
          lastSuccessfulScanAt,
          message: 'No scan performed in this session yet. Call /scan to discover live devices.'
        });
      }
      return sendJson(req, res, 200, lastScanResult);
    }

    if (pathname === '/inspect') {
      const ip = (parsedUrl.searchParams.get('ip') || '').trim();
      const portsParam = parsedUrl.searchParams.get('ports');
      const includePorts = portsParam !== '0' && portsParam !== 'false';
      const out = await inspectDevice(ip, includePorts);
      return sendJson(req, res, out.statusCode, out.body);
    }

    if (pathname === '/history') {
      return sendJson(req, res, 200, {
        lastSuccessfulScanAt,
        totalTrackedDevices: deviceHistory.size,
        devices: Array.from(deviceHistory.values()),
        recentChanges: scanHistoryLog
      });
    }

    return sendJson(req, res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    return sendJson(req, res, 500, { error: err?.message || 'Internal agent error' });
  }
});

server.listen(BIND_PORT, BIND_HOST, () => {
  const netInfo = getLocalNetworkInfo();
  console.log('==============================================================');
  console.log(` NETWATCH Local Discovery & Inspection Agent v${VERSION}`);
  console.log('==============================================================');
  console.log(` Mode:       ${CONFIG.lan ? 'SECURE LAN ACCESS (Token Required)' : 'LOCALHOST ONLY (Default)'}`);
  console.log(` Local URL:  http://127.0.0.1:${BIND_PORT}/`);
  if (netInfo) {
    console.log(` Local IPv4: ${netInfo.localIp} (${netInfo.interface}, ${netInfo.cidr})`);
    if (CONFIG.lan) {
      console.log(` LAN URL:    http://${netInfo.localIp}:${BIND_PORT}/`);
    }
  } else {
    console.log(' Local IPv4: Not detected (no RFC-1918 interface active)');
  }
  if (ACCESS_TOKEN) {
    console.log('--------------------------------------------------------------');
    console.log(` ACCESS TOKEN (enter in NETWATCH Agent Settings):`);
    console.log(`   ${ACCESS_TOKEN}`);
    console.log('--------------------------------------------------------------');
    console.log(' Security: Only devices on your local subnet may connect.');
    console.log('           Never share this token publicly.');
  }
  console.log(' Endpoints:  / | /network | /scan | /devices | /inspect | /history');
  console.log(' Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${BIND_PORT} is already in use. Another NETWATCH Agent instance may be running.`);
  } else {
    console.error('Agent error:', err.message);
  }
  process.exit(1);
});
