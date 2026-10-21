'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('reads only active per-video analysis cooldowns', async (t) => {
  const originalQuery = store.pool.query;
  const queries = [];
  const retryAfter = '2026-10-22T00:00:00.000Z';
  store.pool.query = async (sql, parameters) => {
    queries.push({ sql: String(sql), parameters });
    if (/SELECT status, provider_code AS "providerCode"/.test(String(sql))) {
      return { rows: [{ status: 403, providerCode: 'PERMISSION_DENIED',
        message: 'video is unavailable', retryAfter: new Date(retryAfter) }] };
    }
    return { rows: [] };
  };
  t.after(() => { store.pool.query = originalQuery; });

  const failure = await store.getVideoAnalysisFailure('video-1');

  assert.equal(failure.status, 403);
  assert.equal(failure.providerCode, 'PERMISSION_DENIED');
  assert.equal(failure.retryAfter, retryAfter);
  assert.match(queries.at(-1).sql, /retry_after > NOW()/);
  assert.deepEqual(queries.at(-1).parameters, ['video-1']);
});
