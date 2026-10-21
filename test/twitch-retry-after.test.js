'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retryAfterDetails, waitForClipDownload } = require('../src/twitch');

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


test('clip-download polling stops instead of violating a long Twitch reset', async () => {
  const waits = [];
  let calls = 0;
  const error = Object.assign(new Error('Twitch rate limit'), {
    status: 429, retryAfterMs: 60 * 60 * 1000
  });
  await assert.rejects(waitForClipDownload({
    clipId: 'clip-1', broadcasterId: 'user-1', editorId: 'user-1',
    pollIntervalMs: 1000, maxAttempts: 4,
    helixRequest: async () => { calls += 1; throw error; },
    sleep: async (ms) => { waits.push(ms); }
  }), (caught) => caught === error);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('clip-download polling sleeps for the greater of its interval and a short provider delay', async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(waitForClipDownload({
    clipId: 'clip-1', broadcasterId: 'user-1', editorId: 'user-1',
    pollIntervalMs: 1000, maxAttempts: 3,
    helixRequest: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Twitch rate limit'), {
        status: 429, retryAfterMs: 2500
      });
      throw Object.assign(new Error('Twitch denied'), { status: 403 });
    },
    sleep: async (ms) => { waits.push(ms); }
  }), /Twitch denied/);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2500]);
});
