/**
 * Settings persistence and default configuration for NETWATCH.
 */

const SETTINGS_KEY = 'netwatch.settings.v1';
const AGENT_TOKEN_SESSION_KEY = 'netwatch.agent.token.session';
const AGENT_TOKEN_LOCAL_KEY = 'netwatch.agent.token.local';

export const DEFAULT_ENDPOINTS = [
  {
    id: 'cf-trace',
    name: 'Cloudflare Edge',
    url: 'https://1.1.1.1/cdn-cgi/trace',
    mode: 'cors',
    enabled: true
  },
  {
    id: 'cf-speed',
    name: 'Cloudflare Speed Edge',
    url: 'https://speed.cloudflare.com/__down?bytes=0',
    mode: 'cors',
    enabled: true
  },
  {
    id: 'google-doh',
    name: 'Google DNS Edge',
    url: 'https://dns.google/resolve?name=example.com&type=A',
    mode: 'cors',
    enabled: true
  }
];

export const DEFAULT_WIDGETS = [
  { id: 'status', label: 'Connection Status', visible: true },
  { id: 'ip', label: 'Public IP Address', visible: true },
  { id: 'conntype', label: 'Connection Type', visible: true },
  { id: 'download', label: 'Download Speed', visible: true },
  { id: 'upload', label: 'Upload Speed', visible: true },
  { id: 'latency', label: 'HTTP Latency', visible: true },
  { id: 'jitter', label: 'Jitter', visible: true },
  { id: 'loss', label: 'Probe Failure Rate', visible: true },
  { id: 'uptime', label: 'Session Uptime', visible: true },
  { id: 'live-chart', label: 'Latency Stream Chart', visible: true },
  { id: 'endpoints-health', label: 'Monitored Endpoints', visible: true },
  { id: 'event-log', label: 'Live Event Log', visible: true }
];

export const DEFAULT_SETTINGS = {
  pollIntervalMs: 5000,
  probeTimeoutMs: 4500,
  useWorker: true,
  persistDb: true,
  autoLookupIp: true,
  sidebarCollapsed: false,
  fastMode: false,
  mapPeerCount: 0,
  connectionLabel: '',
  selectedRegions: ['north-america', 'europe'],
  scoreAlertThreshold: 70,
  agent: {
    host: '127.0.0.1',
    port: 7779,
    rememberToken: false
  },
  endpoints: DEFAULT_ENDPOINTS,
  widgets: DEFAULT_WIDGETS.reduce((acc, w) => {
    acc[w.id] = w.visible;
    return acc;
  }, {}),
  alerts: {
    latencyMaxMs: 200,
    jitterMaxMs: 50,
    failureRateMaxPct: 20,
    cooldownSec: 30,
    notifyDisconnect: true,
    notifyBrowser: false
  },
  speedTest: {
    provider: 'cloudflare',
    customDownUrl: '',
    customUpUrl: '',
    downBytes: 15000000,
    upBytes: 5000000
  }
};

export function loadAgentToken(rememberToken = false) {
  try {
    const sessionVal = sessionStorage.getItem(AGENT_TOKEN_SESSION_KEY);
    if (sessionVal) return sessionVal;
    if (rememberToken) {
      return localStorage.getItem(AGENT_TOKEN_LOCAL_KEY) || '';
    }
    return '';
  } catch {
    return '';
  }
}

export function saveAgentToken(token, rememberToken = false) {
  const clean = typeof token === 'string' ? token.trim() : '';
  try {
    if (clean) {
      sessionStorage.setItem(AGENT_TOKEN_SESSION_KEY, clean);
    } else {
      sessionStorage.removeItem(AGENT_TOKEN_SESSION_KEY);
    }
    if (rememberToken && clean) {
      localStorage.setItem(AGENT_TOKEN_LOCAL_KEY, clean);
    } else {
      localStorage.removeItem(AGENT_TOKEN_LOCAL_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      agent: { ...DEFAULT_SETTINGS.agent, ...(parsed.agent || {}) },
      alerts: { ...DEFAULT_SETTINGS.alerts, ...(parsed.alerts || {}) },
      speedTest: { ...DEFAULT_SETTINGS.speedTest, ...(parsed.speedTest || {}) },
      widgets: { ...DEFAULT_SETTINGS.widgets, ...(parsed.widgets || {}) },
      endpoints: Array.isArray(parsed.endpoints) && parsed.endpoints.length > 0
        ? parsed.endpoints
        : structuredClone(DEFAULT_ENDPOINTS)
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}

export function resetSettings() {
  const fresh = structuredClone(DEFAULT_SETTINGS);
  saveSettings(fresh);
  saveAgentToken('', false);
  return fresh;
}
