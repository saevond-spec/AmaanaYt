'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryAfterDetails } = require('../src/twitch');

function makeHeaders(values) {
  return { get(name) { return values[name.toLowerCase()] ?? null; } };
}

test('Twitch rate-limit reset is honored and combined conservatively with Retry-After', () => {
  const now = 1_000_000;
  assert.deepEqual(retryAfterDetails(makeHeaders({
    'ratelimit-reset': '1002',
    'retry-after': '1'
  }), now), { retryAfterPresent: true, retryAfterMs: 2000 });
  assert.deepEqual(retryAfterDetails(makeHeaders({
    'ratelimit-reset': '1005',
    'retry-after': '10'
  }), now), { retryAfterPresent: true, retryAfterMs: 10000 });
});

test('Twitch HTTP-date Retry-After parses and missing reset stays unspecified', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(retryAfterDetails(makeHeaders({
    'retry-after': 'Thu, 01 Jan 2026 00:00:07 GMT'
  }), now), { retryAfterPresent: true, retryAfterMs: 7000 });
  assert.deepEqual(retryAfterDetails(makeHeaders({}), now),
    { retryAfterPresent: false, retryAfterMs: 0 });
});
