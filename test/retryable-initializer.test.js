'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRetryableInitializer } = require('../src/retryable-initializer');

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
