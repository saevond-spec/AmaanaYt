'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRetryableInitializer, initializeWithRetry } = require('../src/retryable-initializer');

test('coalesces concurrent initialization and retries after a transient failure', async () => {
  let attempts = 0;
  const init = createRetryableInitializer(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary database connection failure');
    return 'ready';
  });

  const first = init();
  assert.strictEqual(init(), first);
  await assert.rejects(first, /temporary database connection failure/);

  const second = init();
  assert.strictEqual(init(), second);
  assert.equal(await second, 'ready');
  assert.equal(attempts, 2);
  assert.strictEqual(init(), second);
});

test('startup initializer retries bounded transient failures with exponential jitter', async () => {
  let attempts = 0;
  const delays = [];
  const result = await initializeWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return 'ready';
  }, { maxAttempts: 4, baseDelayMs: 100, random: () => 0.5,
    sleep: async (ms) => delays.push(ms) });

  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('startup initializer fails fast on permanent database errors', async () => {
  let attempts = 0;
  await assert.rejects(initializeWithRetry(async () => {
    attempts += 1;
    throw Object.assign(new Error('permission denied'), { code: '42501' });
  }, { sleep: async () => { throw new Error('must not sleep'); } }), /permission denied/);
  assert.equal(attempts, 1);
});
