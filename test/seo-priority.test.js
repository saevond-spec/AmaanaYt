const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prioritizeSeoAutoCandidates } = require('../src/seo-priority');
const store = require('../src/store');

test('publish queue puts ready low-view videos first and unknown counts last', () => {
  const candidates = [
    { videoId: 'review-low', status: 'needs_review', missingEvidenceCount: 3, viewCount: '2', generatedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'ready-unknown', status: 'ready', viewCount: null, generatedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'ready-high', status: 'ready', viewCount: '1000', generatedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'review-unknown', status: 'needs_review', missingEvidenceCount: 0, viewCount: 'invalid', generatedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'ready-nine', status: 'ready', viewCount: '9', generatedAt: '2025-02-01T00:00:00Z' },
    { videoId: 'review-lowest', status: 'needs_review', missingEvidenceCount: 0, viewCount: '0', generatedAt: '2026-01-01T00:00:00Z' }
  ];
  const originalOrder = candidates.map(({ videoId }) => videoId);

  const result = prioritizeSeoAutoCandidates(candidates);

  assert.deepEqual(result.map(({ videoId }) => videoId), [
    'ready-nine', 'ready-high', 'ready-unknown', 'review-lowest', 'review-low', 'review-unknown'
  ]);
  assert.deepEqual(candidates.map(({ videoId }) => videoId), originalOrder);
});

test('view counts sort numerically and the result limit applies after priority sorting', () => {
  const candidates = [
    { videoId: 'views-100', status: 'ready', viewCount: '100' },
    { videoId: 'views-9', status: 'ready', viewCount: '9' },
    { videoId: 'views-12', status: 'ready', viewCount: '12' }
  ];

  assert.deepEqual(prioritizeSeoAutoCandidates(candidates, 2).map(({ videoId }) => videoId),
    ['views-9', 'views-12']);
  assert.deepEqual(prioritizeSeoAutoCandidates([], 20), []);
});

test('database queues use numeric low-view order and keep SEO work public-only', async (t) => {
  const originalQuery = store.pool.query;
  const calls = [];
  store.pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  t.after(() => { store.pool.query = originalQuery; });

  await store.listSeoVideos();
  await store.claimSeoVideo();
  await store.listSeoAutoCandidates();
  await store.listSeoNeedsAnalysis();

  const sql = calls.map(({ sql }) => sql);
  const dashboard = sql.find((query) =>
    query.includes('SELECT p.video_id AS "videoId", p.source, p.context, p.package, p.status'));
  const generation = sql.find((query) => query.includes('WITH candidate AS'));
  const autoPublish = sql.find((query) => query.includes('SELECT video_id AS "videoId", status'));
  const analysis = sql.find((query) =>
    query.includes('SELECT p.video_id AS "videoId", p.context'));

  assert.ok(dashboard?.includes("p.source->>'privacyStatus' = 'public' THEN 0 ELSE 1 END"));
  assert.ok(dashboard?.includes("THEN (p.source->>'viewCount')::numeric"));
  assert.ok(generation?.includes("source->>'privacyStatus' = 'public'"));
  assert.ok(generation?.includes("THEN (source->>'viewCount')::numeric"));
  assert.ok(autoPublish?.includes('AS "viewCount"'));
  assert.ok(analysis?.includes("THEN (p.source->>'viewCount')::numeric"));
});
