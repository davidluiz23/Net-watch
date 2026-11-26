/**
 * Web Worker for computationally intensive telemetry statistics & analytics aggregation.
 */

function calculateJitter(values) {
  if (values.length < 2) return null;
  let j = 0;
  for (let i = 1; i < values.length; i += 1) {
    j += (Math.abs(values[i] - values[i - 1]) - j) / 16;
  }
  return j;
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  if (type === 'ANALYZE_WINDOW') {
    const { samples = [], incidents = [], rangeMs = 900000, now = Date.now() } = payload;
    const cutoff = now - rangeMs;
    const prevCutoff = cutoff - rangeMs;

    const current = samples.filter((s) => s.timestamp >= cutoff);
    const previous = samples.filter((s) => s.timestamp >= prevCutoff && s.timestamp < cutoff);

    const okCurrent = current.filter((s) => s.ok && Number.isFinite(s.rttMs));
    const okPrev = previous.filter((s) => s.ok && Number.isFinite(s.rttMs));

    const avgLatency = okCurrent.length
      ? okCurrent.reduce((sum, s) => sum + s.rttMs, 0) / okCurrent.length
      : null;

    const prevAvgLatency = okPrev.length
      ? okPrev.reduce((sum, s) => sum + s.rttMs, 0) / okPrev.length
      : null;

    const rtts = okCurrent.map((s) => s.rttMs);
    const avgJitter = calculateJitter(rtts);

    const availabilityPct = current.length
      ? (okCurrent.length / current.length) * 100
      : null;

    const windowIncidents = incidents.filter((inc) => inc.timestamp >= cutoff);

    // Bucket into 12 intervals for availability and interruptions charts
    const bucketCount = 12;
    const bucketSize = rangeMs / bucketCount;
    const availabilityBuckets = [];
    const interruptionBuckets = [];

    for (let i = 0; i < bucketCount; i += 1) {
      const start = cutoff + i * bucketSize;
      const end = start + bucketSize;
      const inBucket = current.filter((s) => s.timestamp >= start && s.timestamp < end);
      const okInBucket = inBucket.filter((s) => s.ok);
      const incInBucket = windowIncidents.filter((inc) => inc.timestamp >= start && inc.timestamp < end);

      const d = new Date(start);
      const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      availabilityBuckets.push({
        label,
        value: inBucket.length ? (okInBucket.length / inBucket.length) * 100 : 0
      });
      interruptionBuckets.push({
        label,
        value: incInBucket.length
      });
    }

    self.postMessage({
      id,
      result: {
        count: current.length,
        avgLatency,
        prevAvgLatency,
        latencyDelta: avgLatency !== null && prevAvgLatency !== null ? avgLatency - prevAvgLatency : null,
        avgJitter,
        availabilityPct,
        interruptionCount: windowIncidents.length,
        availabilityBuckets,
        interruptionBuckets
      }
    });
  }
};
