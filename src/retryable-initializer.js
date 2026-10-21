'use strict';

const TRANSIENT_DATABASE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'EHOSTUNREACH', '57P01', '57P03', '53300', '40001'
]);

function isTransientDatabaseError(error) {
  const code = String(error && (error.code || error.cause && error.cause.code) || '').toUpperCase();
  return TRANSIENT_DATABASE_CODES.has(code) || code.startsWith('08');
}

async function initializeWithRetry(initialize, options = {}) {
  if (typeof initialize !== 'function') throw new TypeError('Initializer must be a function');
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts >= 1
    ? Math.min(6, options.maxAttempts) : 4;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs >= 0
    ? Math.min(30000, options.baseDelayMs) : 250;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs >= 0
    ? Math.min(60000, options.maxDelayMs) : 4000;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const sleep = typeof options.sleep === 'function' ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shouldRetry = typeof options.shouldRetry === 'function'
    ? options.shouldRetry : isTransientDatabaseError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await initialize();
    } catch (error) {
      if (attempt + 1 >= maxAttempts || !shouldRetry(error)) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const jittered = Math.ceil(exponential * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
      options.onRetry?.(error, attempt + 1, jittered);
      await sleep(jittered);
    }
  }
  throw new Error('Database initialization retry loop ended unexpectedly');
}

function createRetryableInitializer(initialize) {
  if (typeof initialize !== 'function') throw new TypeError('Initializer must be a function');
  let initialized;
  return function init() {
    if (!initialized) {
      let attempt;
      attempt = Promise.resolve().then(initialize).catch((error) => {
        if (initialized === attempt) initialized = undefined;
        throw error;
      });
      initialized = attempt;
    }
    return initialized;
  };
}

module.exports = { createRetryableInitializer, initializeWithRetry, isTransientDatabaseError };
