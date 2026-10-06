const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');

test('candidate scan requeues results written by an older autopilot version', async () => {
  const calls = [];
  const originalQuery = store.pool.query;
  store.pool.query = async (...args) => {
    calls.push(args);
    return { rows: [] };
  };
  try {
    const rows = await store.listSeoAutoCandidates(20, 'public-seo-metadata-test-v2');
    assert.deepEqual(rows, []);
    const candidateQuery = calls.find(([query]) =>
      String(query).includes('SELECT video_id AS "videoId"'));
    assert.ok(candidateQuery, 'candidate SQL should execute');
    assert.match(candidateQuery[0],
      /auto_result->>'autopilotVersion'\s+IS DISTINCT FROM \$1/);
    assert.deepEqual(candidateQuery[1], ['public-seo-metadata-test-v2']);
  } finally {
    store.pool.query = originalQuery;
  }
});
