/**
 * Shared utility helpers for NETWATCH.
 */

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(ts) {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export function formatMs(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  return `${val.toFixed(1)} ms`;
}

export function formatMbps(val) {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  return `${val.toFixed(2)} Mbps`;
}

/**
 * Validates user-configured HTTP/HTTPS URLs and blocks unsafe schemes or metadata targets.
 * @param {string} rawUrl
 * @returns {{ valid: boolean, url?: string, error?: string }}
 */
export function validateEndpointUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'URL cannot be empty.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    return { valid: false, error: 'Only HTTPS URLs (or local http://localhost) are allowed.' };
  }

  // Block link-local / cloud metadata addresses
  if (host.startsWith('169.254.') || host === 'metadata.google.internal') {
    return { valid: false, error: 'Link-local and metadata endpoints are blocked.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Embedded credentials in URLs are not permitted.' };
  }

  return { valid: true, url: parsed.toString() };
}

/**
 * Validates a hostname for DNS lookup.
 */
export function validateHostname(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase();
  if (!host || host.length > 253) return { valid: false, error: 'Invalid hostname length.' };
  const hostnameRegex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!hostnameRegex.test(host)) {
    return { valid: false, error: 'Enter a valid domain name (e.g., cloudflare.com).' };
  }
  return { valid: true, host };
}

/**
 * Computes RFC 3550 interarrival jitter from an array of RTT values.
 * J_i = J_{i-1} + (|D(i-1, i)| - J_{i-1}) / 16
 */
export function calculateRfc3550Jitter(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  let jitter = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const diff = Math.abs(samples[i] - samples[i - 1]);
    jitter += (diff - jitter) / 16;
  }
  return jitter;
}

export function showToast(message, level = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast--${level}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 4200);
}

export function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
