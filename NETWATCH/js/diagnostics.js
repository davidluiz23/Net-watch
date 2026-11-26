/**
 * Network Diagnostics suite:
 * - DNS-over-HTTPS resolution (Google DoH + Cloudflare DoH fallback)
 * - HTTP endpoint availability & timing check
 * - Browser connectivity & Navigator Network Information check
 * - Public IP & edge PoP lookup
 * - Actionable troubleshooting recommendations
 */

import { validateEndpointUrl, validateHostname } from './utils.js';

export class DiagnosticsEngine {
  async resolveDns(rawHost, recordType = 'A') {
    const check = validateHostname(rawHost);
    if (!check.valid) {
      return { ok: false, name: 'DNS Resolution', error: check.error, records: [] };
    }

    const allowedTypes = ['A', 'AAAA', 'MX', 'TXT'];
    const rType = allowedTypes.includes(recordType) ? recordType : 'A';
    const start = performance.now();

    // Primary: Google DoH
    try {
      const url = `https://dns.google/resolve?name=${encodeURIComponent(check.host)}&type=${encodeURIComponent(rType)}`;
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const rttMs = performance.now() - start;
      if (res.ok) {
        const data = await res.json();
        const records = (data.Answer || []).map((a) => ({
          name: a.name,
          ttl: a.TTL,
          data: a.data
        }));
        return {
          ok: data.Status === 0 && records.length > 0,
          name: `DNS Resolution (${check.host} ${rType})`,
          resolver: 'dns.google (DoH)',
          statusCode: data.Status,
          rttMs,
          records,
          error: data.Status !== 0 ? `DNS Status ${data.Status}` : (records.length === 0 ? 'No matching records found' : null)
        };
      }
    } catch {
      // Fallback to Cloudflare DoH
    }

    // Fallback: Cloudflare DoH
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(check.host)}&type=${encodeURIComponent(rType)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      const rttMs = performance.now() - start;
      if (res.ok) {
        const data = await res.json();
        const records = (data.Answer || []).map((a) => ({
          name: a.name,
          ttl: a.TTL,
          data: a.data
        }));
        return {
          ok: data.Status === 0 && records.length > 0,
          name: `DNS Resolution (${check.host} ${rType})`,
          resolver: 'cloudflare-dns.com (DoH)',
          statusCode: data.Status,
          rttMs,
          records,
          error: records.length === 0 ? 'No matching records found' : null
        };
      }
    } catch {
      // Unreachable
    }

    return {
      ok: false,
      name: `DNS Resolution (${check.host} ${rType})`,
      rttMs: performance.now() - start,
      records: [],
      error: 'DoH resolvers unreachable or blocked'
    };
  }

  async checkHttpEndpoint(rawUrl) {
    const check = validateEndpointUrl(rawUrl);
    if (!check.valid) {
      return { ok: false, name: 'HTTP Endpoint Check', url: rawUrl, error: check.error };
    }

    const start = performance.now();
    try {
      const url = new URL(check.url);
      url.searchParams.set('_diag', `${Date.now()}`);
      const res = await fetch(url.toString(), {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        signal: AbortSignal.timeout(6000)
      });
      const rttMs = performance.now() - start;
      return {
        ok: res.ok,
        name: `HTTP Availability (${url.hostname})`,
        url: check.url,
        status: res.status,
        statusText: res.statusText || (res.ok ? 'OK' : 'Error'),
        rttMs,
        error: res.ok ? null : `HTTP ${res.status}`
      };
    } catch (err) {
      // Retry with no-cors to distinguish CORS header restriction vs full unreachability
      try {
        const url = new URL(check.url);
        url.searchParams.set('_diag', `${Date.now()}`);
        await fetch(url.toString(), {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          signal: AbortSignal.timeout(6000)
        });
        const rttMs = performance.now() - start;
        return {
          ok: true,
          opaque: true,
          name: `HTTP Availability (${url.hostname})`,
          url: check.url,
          status: 0,
          statusText: 'Reachable (CORS opaque response)',
          rttMs,
          error: null
        };
      } catch {
        const rttMs = performance.now() - start;
        return {
          ok: false,
          name: `HTTP Availability`,
          url: check.url,
          rttMs,
          error: err?.name === 'TimeoutError' ? 'Request timed out' : 'Endpoint unreachable'
        };
      }
    }
  }

  checkBrowserConnectivity(networkMonitor) {
    const snap = networkMonitor.getStatusSnapshot();
    const conn = snap.connection;
    const details = [];
    details.push(`navigator.onLine: ${snap.online ? 'true' : 'false'}`);
    if (conn.supported) {
      if (conn.type) details.push(`type: ${conn.type}`);
      if (conn.effectiveType) details.push(`effectiveType: ${conn.effectiveType}`);
      if (conn.downlink !== null) details.push(`est. downlink: ${conn.downlink} Mbps`);
      if (conn.rtt !== null) details.push(`est. rtt: ${conn.rtt} ms`);
    } else {
      details.push('Navigator NetworkInformation API not exposed by this browser');
    }

    return {
      ok: snap.online,
      name: 'Browser Connectivity & Interface',
      summary: details.join(' | '),
      error: snap.online ? null : 'Browser reports offline state'
    };
  }

  async runFullSuite({ domain, recordType, url, networkMonitor }) {
    const browserCheck = this.checkBrowserConnectivity(networkMonitor);
    const [dnsResult, httpResult, publicIp] = await Promise.all([
      this.resolveDns(domain, recordType),
      this.checkHttpEndpoint(url),
      networkMonitor.lookupPublicIp()
    ]);

    const ipResult = {
      ok: Boolean(publicIp),
      name: 'Public IP Lookup',
      summary: publicIp ? `Resolved public IP: ${publicIp}` : 'Unable to determine public IP',
      error: publicIp ? null : 'IP lookup services unreachable'
    };

    const results = [browserCheck, ipResult, dnsResult, httpResult];
    const recommendations = this.buildRecommendations(results, networkMonitor.getStatusSnapshot());
    return { results, recommendations };
  }

  buildRecommendations(results, snapshot) {
    const recs = [];
    const browser = results.find((r) => r.name.startsWith('Browser'));
    const ip = results.find((r) => r.name.startsWith('Public IP'));
    const dns = results.find((r) => r.name.startsWith('DNS'));
    const http = results.find((r) => r.name.startsWith('HTTP'));

    if (!snapshot.online || (browser && !browser.ok)) {
      recs.push({
        severity: 'error',
        title: 'Local Network Interface Disconnected',
        detail: 'Verify Wi-Fi/Ethernet link, check airplane mode, and confirm local router/gateway power.'
      });
    }

    if (ip && !ip.ok && snapshot.online) {
      recs.push({
        severity: 'warn',
        title: 'Public IP Lookup Blocked or Unreachable',
        detail: 'Check firewall/proxy rules, VPN status, or browser privacy extensions blocking external API calls.'
      });
    }

    if (dns && !dns.ok) {
      recs.push({
        severity: 'warn',
        title: 'DNS-over-HTTPS Resolution Issue',
        detail: 'Verify DNS settings, test another hostname, or inspect corporate DNS/proxy filtering.'
      });
    } else if (dns && dns.rttMs > 200) {
      recs.push({
        severity: 'warn',
        title: 'Elevated DNS Lookup Latency',
        detail: `DoH resolution took ${dns.rttMs.toFixed(0)} ms. Consider switching to a closer resolver (1.1.1.1 / 8.8.8.8).`
      });
    }

    if (http && !http.ok) {
      recs.push({
        severity: 'error',
        title: 'Target Endpoint Unreachable',
        detail: 'Confirm the target URL is online, serves valid TLS certificates, and is not blocked by local firewall rules.'
      });
    } else if (http && http.opaque) {
      recs.push({
        severity: 'info',
        title: 'CORS Header Restriction Observed',
        detail: 'Target responded over the network but omits Access-Control-Allow-Origin headers, limiting status/timing detail in browsers.'
      });
    }

    if (recs.length === 0) {
      recs.push({
        severity: 'ok',
        title: 'All Diagnostic Checks Nominal',
        detail: 'Connectivity, DNS resolution, public IP reachability, and target HTTP response are healthy.'
      });
    }

    return recs;
  }
}
