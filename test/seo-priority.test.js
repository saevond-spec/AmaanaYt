const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prioritizeSeoAutoCandidates } = require('../src/seo-priority');

test('auto-publish queue puts ready packages and low-evidence-gap reviews first', () => {
  const candidates = [
    { videoId: 'review-unknown', status: 'needs_review', generatedAt: '2026-01-01T00:00:00Z' },
    { videoId: 'review-many', status: 'needs_review', missingEvidenceCount: 3, generatedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'review-one-new', status: 'needs_review', missingEvidenceCount: 1, generatedAt: '2026-03-01T00:00:00Z' },
    { videoId: 'ready-new', status: 'ready', missingEvidenceCount: 0, generatedAt: '2026-02-01T00:00:00Z' },
    { videoId: 'review-zero', status: 'needs_review', missingEvidenceCount: 0, generatedAt: '2026-04-01T00:00:00Z' },
    { videoId: 'ready-old', status: 'ready', missingEvidenceCount: 0, generatedAt: '2026-01-01T00:00:00Z' },
    { videoId: 'review-one-a', status: 'needs_review', missingEvidenceCount: 1, generatedAt: '2026-01-01T00:00:00Z' },
    { videoId: 'review-one-b', status: 'needs_review', missingEvidenceCount: 1, generatedAt: '2026-01-01T00:00:00Z' }
  ];
  const originalOrder = candidates.map(({ videoId }) => videoId);

  const result = prioritizeSeoAutoCandidates(candidates, 20);

  assert.deepEqual(result.map(({ videoId }) => videoId), [
    'ready-old',
    'ready-new',
    'review-zero',
    'review-one-a',
    'review-one-b',
    'review-one-new',
    'review-many',
    'review-unknown'
  ]);
  assert.deepEqual(candidates.map(({ videoId }) => videoId), originalOrder);
});

test('auto-publish queue applies its limit after priority sorting', () => {
  const candidates = [
    { videoId: 'review', status: 'needs_review', missingEvidenceCount: 1, generatedAt: '2026-01-01T00:00:00Z' },
    { videoId: 'ready', status: 'ready', generatedAt: '2026-02-01T00:00:00Z' },
    { videoId: 'review-easy', status: 'needs_review', missingEvidenceCount: 0, generatedAt: '2026-03-01T00:00:00Z' }
  ];

  assert.deepEqual(prioritizeSeoAutoCandidates(candidates, 2).map(({ videoId }) => videoId),
    ['ready', 'review-easy']);
});
