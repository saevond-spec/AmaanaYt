'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminLoginProtection } = require('../src/admin-login-protection');

test('limits repeated failed admin logins by client and releases after the cooldown', () => {
  let time = 1_000_000;
  const limiter = createAdminLoginProtection({
    now: () => time, maxFailures: 3, windowMs: 60_000, blockMs: 30_000
  });
  assert.equal(limiter.check('ip-a').blocked, false);
  limiter.recordFailure('ip-a');
  limiter.recordFailure('ip-a');
  assert.deepEqual(limiter.recordFailure('ip-a'), { blocked: true, retryAfterSeconds: 30 });
  assert.deepEqual(limiter.check('ip-a'), { blocked: true, retryAfterSeconds: 30 });
  assert.equal(limiter.check('ip-b').blocked, false);
  time += 29_001;
  assert.equal(limiter.check('ip-a').retryAfterSeconds, 1);
  time += 999;
  assert.equal(limiter.check('ip-a').blocked, false);
});

test('a successful login clears only that client and expired failures age out', () => {
  let time = 10_000;
  const limiter = createAdminLoginProtection({ now: () => time, maxFailures: 2, windowMs: 5000 });
  limiter.recordFailure('ip-a');
  limiter.recordFailure('ip-a');
  limiter.clear('ip-a');
  assert.equal(limiter.check('ip-a').blocked, false);
  limiter.recordFailure('ip-b');
  time += 5001;
  assert.equal(limiter.check('ip-b').blocked, false);
  assert.equal(limiter.size(), 0);
});

test('bounds in-memory client state under a high-cardinality request burst', () => {
  const limiter = createAdminLoginProtection({ maxEntries: 10 });
  for (let index = 0; index < 100; index += 1) limiter.recordFailure('ip-' + index);
  assert.equal(limiter.size() <= 10, true);
});
