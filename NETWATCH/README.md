# NETWATCH — Network Intelligence & Monitoring Platform

NETWATCH is a browser-based network intelligence dashboard paired with an optional, lightweight **Node.js Local Discovery & Inspection Agent** (`agent.js`). All displayed telemetry is real — never fabricated — and clearly distinguishes actual browser/agent measurements from estimated or unavailable data.

---

## Quick Start (Host Laptop — Localhost Mode)

### 1. Start the Web Dashboard
```powershell
powershell -ExecutionPolicy Bypass -File start-server.ps1
```
Open **http://localhost:8775/** in your browser.

### 2. Start the Local Discovery Agent (Default Localhost Mode)
Requires **Node.js 18+** (no npm install required — zero external dependencies).

Double-click **`start-agent.bat`** or run:
```cmd
node agent.js
```
This binds strictly to **`127.0.0.1:7779`**.

1. Go to **Network Map** in NETWATCH.
2. Click **Scan Network** to discover devices on your local subnet.
3. Click **any device node** (or any device in the sidebar list) to open the **Device Details Inspector** with live ICMP reachability, measured RTT, MAC/OUI vendor lookup, authorized common TCP port checks, and appearance/disappearance history.

---

## Secure LAN Access (Connect From a Phone on the Same Wi-Fi)

By default, `agent.js` binds exclusively to `127.0.0.1` so no other device can access it. To view your laptop's scans and inspect devices from a phone or tablet on the **same Wi-Fi**:

### Step 1 — Start the Agent in Secure LAN Mode
Double-click **`start-agent-lan.bat`** or run:
```cmd
node agent.js --lan
```
The terminal displays:
- Your laptop's **Local IPv4 address** (e.g., `192.168.1.42`)
- The **LAN URL** (`http://192.168.1.42:7779/`)
- A randomly generated **Access Token** (required for all LAN clients)

### Step 2 — Serve the Dashboard on Your LAN (Recommended for Phones)
Modern browsers block HTTPS pages (such as a Vercel deployment) from making HTTP requests to private LAN IP addresses (*Mixed Content / Private Network Access* policy). Serving the dashboard locally over HTTP on your Wi-Fi avoids this cleanly:
```powershell
powershell -ExecutionPolicy Bypass -File start-server.ps1 -Lan
```
Note the LAN URL printed (e.g., `http://192.168.1.42:8775/`).

### Step 3 — Configure Windows Firewall Safely (Scoped to Private LocalSubnet Only)
Run PowerShell **as Administrator** on your laptop to allow ports `7779` (agent) and `8775` (dashboard) **only on Private networks from your Local Subnet** (never on Public Wi-Fi or the internet):
```powershell
New-NetFirewallRule -DisplayName "NETWATCH Agent (Private LAN Only)" `
  -Direction Inbound -Protocol TCP -LocalPort 7779 `
  -Profile Private -RemoteAddress LocalSubnet -Action Allow

New-NetFirewallRule -DisplayName "NETWATCH Dashboard (Private LAN Only)" `
  -Direction Inbound -Protocol TCP -LocalPort 8775 `
  -Profile Private -RemoteAddress LocalSubnet -Action Allow
```
To remove these rules later:
```powershell
Remove-NetFirewallRule -DisplayName "NETWATCH Agent (Private LAN Only)"
Remove-NetFirewallRule -DisplayName "NETWATCH Dashboard (Private LAN Only)"
```

### Step 4 — Connect From Your Phone
1. Ensure your phone is connected to the **exact same Wi-Fi network** as the laptop.
2. Open `http://<laptop-ip>:8775/` in your phone's browser.
3. Open **Settings → Local Discovery Agent Connection** (or click **Agent Settings** on the Network Map).
4. Enter:
   - **Agent Host / Laptop IPv4:** `<laptop-ip>` (e.g., `192.168.1.42`)
   - **Agent Port:** `7779`
   - **Access Token:** paste the random token printed by `node agent.js --lan`
5. Tap **Save & Test Connection**, then open **Network Map** and tap **Scan Network** or **Refresh**.

### Router AP / Client Isolation Restrictions
If your phone cannot reach the laptop even after configuring Windows Firewall:
- Many guest Wi-Fi networks, campus/hotel Wi-Fi networks, and some home routers enable **AP Isolation / Client Isolation / Wireless Isolation**.
- When client isolation is enabled, the router intentionally drops direct packets between Wi-Fi clients, which prevents both LAN device discovery and phone-to-laptop agent connections.
- Use your main trusted home/office Wi-Fi network (not Guest Wi-Fi) and verify client isolation is disabled if you control the router.

---

## Agent REST API Reference (v2.0.0)

| Endpoint | Method | Auth in LAN Mode | Description |
|----------|--------|------------------|-------------|
| `/` | `GET` | Optional (minimal info if unauth) | Health check, version, mode, local IP/CIDR/gateway (when authenticated) |
| `/network` | `GET` | **Required** | Detected local IPv4, subnet CIDR, netmask, interface name, default gateway |
| `/scan` | `GET` | **Required** | ARP + ICMP sweep of detected local RFC-1918 subnet, measured RTT, scan diff |
| `/devices` | `GET` | **Required** | Last cached online & offline devices and recent scan diff |
| `/inspect?ip=<ipv4>&ports=1` | `GET` | **Required** | Live 3-probe ICMP reachability + min/avg/max RTT, fresh ARP/DNS, limited common TCP port check, full device history |
| `/history` | `GET` | **Required** | Persistent device appearance/disappearance history across scans |

Authentication headers accepted: `Authorization: Bearer <token>` or `X-Netwatch-Token: <token>`.

---

## Security & Scope Boundaries

- **Localhost default:** `node agent.js` binds strictly to `127.0.0.1:7779`.
- **No unauthenticated LAN mode:** `--lan` always generates a 192-bit cryptographically random token (or requires a user-supplied `--token` of ≥ 16 chars) and compares tokens using constant-time `crypto.timingSafeEqual`.
- **Strict subnet enforcement:** Both incoming LAN client IPs and `/inspect` target IPs are validated against the host's detected local RFC-1918 subnet. External/internet IPs are rejected with `403 Forbidden`.
- **Safe diagnostics only:** `/inspect` checks only a fixed allowlist of 12 common local service ports (`22, 53, 80, 443, 445, 548, 554, 3389, 5000, 8080, 8443, 9100`) via plain TCP connect with a 600 ms timeout. No credential guessing, no exploitation, no packet capture.
- **No hardcoded tokens:** The frontend never embeds access tokens. Tokens are stored in `sessionStorage` by default (cleared when closing the tab), or `localStorage` only if explicitly opted in.
- **Vercel compatibility:** Deploying the static frontend to Vercel continues to work cleanly. The local agent is never exposed through Vercel; when unreachable, NETWATCH clearly displays that local discovery requires the companion agent and never fabricates devices.

---

## Information That Cannot Reliably Be Retrieved

NETWATCH is strictly transparent about local-network telemetry limits:
- **Exact OS & hardware model:** Cannot be reliably determined without invasive fingerprinting or authenticated access; NETWATCH never fabricates OS or device model claims.
- **Device type (phone / laptop / IoT):** Estimated from MAC OUI vendor or hostname and explicitly labeled `ESTIMATED` (except for the host running the agent and the OS-confirmed default gateway, which are labeled `CONFIRMED`).
- **Randomized / Private MAC addresses:** Modern iOS, Android, and Windows devices rotate locally-administered MAC addresses on Wi-Fi; OUI lookup reports `Unknown (Randomized / Private MAC)` instead of guessing a manufacturer.
- **Unmapped OUI vendors:** The zero-dependency agent includes a curated table of common OUI prefixes; unrecognized prefixes are honestly labeled `Unknown`.
- **Silent / firewalled devices:** Devices configured to drop ICMP echo requests and not present in the host's ARP cache (or isolated by AP isolation) may not appear during discovery.
- **Filtered ports:** A closed or firewall-filtered TCP port cannot be distinguished from an unused port; NETWATCH only displays confirmed open TCP ports.
