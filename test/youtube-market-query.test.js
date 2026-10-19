'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRecentGameVideoSearchQueries, uniqueRecentGameVideoIds } = require('../src/youtube');

const DAY_MS = 24 * 60 * 60 * 1000;

test('recent game market research samples newest and highest-view public search cohorts', () => {
  const now = Date.parse('2026-10-19T12:00:00.000Z');
  const queries = buildRecentGameVideoSearchQueries('ARC Raiders', { now });

  assert.deepEqual(queries.map((query) => query.order), ['date', 'viewCount']);
  assert.deepEqual(queries.map((query) => query.maxResults), [25, 25]);
  assert.ok(queries.every((query) => query.type === 'video' && query.part.includes('snippet')));
  assert.ok(queries.every((query) => query.q === 'ARC Raiders gameplay'));
  assert.ok(queries.every((query) => query.publishedAfter === new Date(now - 7 * DAY_MS).toISOString()));
});

test('game market result union deduplicates overlap and discards malformed search items', () => {
  const ids = uniqueRecentGameVideoIds([
    { data: { items: [
      { id: { videoId: 'first-video' } },
      { id: { videoId: 'shared-video' } },
      { id: { playlistId: 'not-a-video' } },
      { id: { videoId: '' } }
    ] } },
    { data: { items: [
      { id: { videoId: 'shared-video' } },
      { id: { videoId: 'second-video' } },
      null
    ] } }
  ]);
  assert.deepEqual(ids, ['first-video', 'shared-video', 'second-video']);
});

test('market queries reject invalid dates and empty game names', () => {
  assert.throws(() => buildRecentGameVideoSearchQueries('ARC Raiders', { now: NaN }), /valid/);
  assert.throws(() => buildRecentGameVideoSearchQueries('ARC Raiders', { now: 1e100 }), /valid/);
  assert.throws(() => buildRecentGameVideoSearchQueries('  '), /game name/);
});
