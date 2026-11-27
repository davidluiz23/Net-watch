# NETWATCH — Network Intelligence & Monitoring Platform

## Quick Start

### 1. Start the web server (PowerShell)
```powershell
powershell -ExecutionPolicy Bypass -File start-server.ps1
```
Then open **http://localhost:8775/** in your browser.

### 2. Enable Local Network Discovery (optional)

LAN device discovery requires the companion **Node.js agent**.

**Prerequisites:** [Node.js 18+](https://nodejs.org/)

**Windows:**
```
double-click  start-agent.bat
```
or
```cmd
node agent.js
```

The agent binds to `127.0.0.1:7779` only. It never contacts the internet.

Once the agent is running:
1. Open the **Network Map** view in NETWATCH.
2. Click **Scan Network**.
3. The map will populate with discovered LAN devices.

---

## Agent API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check, agent version, local IP |
| `/network` | GET | Local IP, subnet, CIDR, gateway, hostname |
| `/scan` | GET | Run ARP/ping sweep — returns device list (takes ~20–40 s) |
| `/devices` | GET | Return last cached scan result |

All responses are JSON. The agent enforces:
- Localhost-only binding (`127.0.0.1`)
- RFC-1918 subnet restriction (no internet scanning)
- Maximum /16 subnet scan (capped at /24 in practice)
- No credential attempts, no packet capture, no port scanning

---

## Features

| Feature | Technology | Notes |
|---------|-----------|-------|
| Connection status | Navigator online API | Real |
| Public IP | ipify / Cloudflare trace | Real |
| Download speed | Fetch streaming | Real |
| Upload speed | XMLHttpRequest | Real |
| Latency / Jitter | HTTP timing | Real |
| DNS diagnostics | DNS-over-HTTPS | Real |
| LAN device discovery | Node.js agent ARP/ping | Real (agent required) |
| Gateway detection | ARP table + route print | Real (agent required) |
| MAC / Vendor lookup | Bundled OUI table | Partial — top OUI prefixes |
| Internet endpoint map | Latency monitor | Real |
| Illustrative gateway | Canvas | ILLUSTRATIVE when no agent |

---

## Security

- The local agent **never** scans outside the detected RFC-1918 subnet.
- It **never** sends data to any remote server.
- It **never** attempts logins, exploits, or traffic capture.
- All agent communication is `127.0.0.1` only.
- The agent has no authentication — do not expose port 7779 externally.

---

## Vercel Deployment

The NETWATCH frontend deploys to Vercel without modification.
The local agent is **not** deployed — it runs only on the user's machine.
When the agent is unavailable (e.g., Vercel deployment), the Network Map
displays internet endpoints and illustrative gateway nodes only.

---

## File Structure

```
NETWATCH/
├── index.html          Main application shell
├── start-server.ps1    PowerShell static file server (port 8775)
├── agent.js            Node.js local discovery agent (port 7779)
├── start-agent.bat     Windows double-click launcher for agent
├── css/
│   ├── main.css
│   ├── components.css
│   ├── dashboard.css
│   └── responsive.css
├── js/
│   ├── app.js              Application controller
│   ├── network-map.js      Canvas visualizer + LAN integration
│   ├── network-monitor.js  Online/offline + public IP
│   ├── latency-monitor.js  Endpoint probing
│   ├── speed-test.js       Download/upload measurement
│   ├── diagnostics.js      DNS-over-HTTPS + endpoint check
│   ├── analytics.js        IndexedDB charts
│   ├── alerts.js           Threshold alerting
│   ├── settings.js         Persistent configuration
│   ├── storage.js          IndexedDB wrapper
│   ├── utils.js            Helpers
│   └── chart-renderer.js   Canvas chart drawing
└── assets/
    └── icons/
```
