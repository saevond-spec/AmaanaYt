'use strict';

function createAdminLoginProtection({
  now = () => Date.now(),
  maxFailures = 5,
  windowMs = 15 * 60 * 1000,
  blockMs = 15 * 60 * 1000,
  maxEntries = 1000
} = {}) {
  const entries = new Map();
  const failureLimit = Math.max(1, Math.floor(Number(maxFailures) || 5));
  const window = Math.max(1000, Number(windowMs) || 15 * 60 * 1000);
  const block = Math.max(1000, Number(blockMs) || 15 * 60 * 1000);
  const capacity = Math.max(10, Math.floor(Number(maxEntries) || 1000));

  function timestamp() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new Error('Login protection clock must return milliseconds');
    return value;
  }

  function prune(currentTime) {
    for (const [key, value] of entries) {
      if (value.blockedUntil <= currentTime && currentTime - value.lastSeenAt >= window) entries.delete(key);
    }
    while (entries.size > capacity) entries.delete(entries.keys().next().value);
  }

  function check(key) {
    const currentTime = timestamp();
    prune(currentTime);
    const normalized = String(key || 'unknown').slice(0, 200);
    const value = entries.get(normalized);
    if (!value || value.blockedUntil <= currentTime) return { blocked: false, retryAfterSeconds: 0 };
    value.lastSeenAt = currentTime;
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((value.blockedUntil - currentTime) / 1000)) };
  }

  function recordFailure(key) {
    const currentTime = timestamp();
    prune(currentTime);
    const normalized = String(key || 'unknown').slice(0, 200);
    let value = entries.get(normalized);
    if (!value || currentTime - value.windowStartedAt >= window || value.blockedUntil > 0 && value.blockedUntil <= currentTime) {
      value = { failures: 0, windowStartedAt: currentTime, blockedUntil: 0, lastSeenAt: currentTime };
    }
    value.failures += 1;
    value.lastSeenAt = currentTime;
    if (value.failures >= failureLimit) value.blockedUntil = currentTime + block;
    entries.delete(normalized);
    entries.set(normalized, value);
    prune(currentTime);
    return check(normalized);
  }

  function clear(key) {
    entries.delete(String(key || 'unknown').slice(0, 200));
  }

  return { check, recordFailure, clear, size: () => entries.size };
}

module.exports = { createAdminLoginProtection };
