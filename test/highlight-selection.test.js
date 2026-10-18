'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { select15MinuteGameplayHighlights } = require('../src/highlight-selection');

const vod = {
  id: '1001', user_id: 'broadcaster-1', type: 'archive', duration: '2h',
  created_at: '2026-10-18T12:00:00.000Z'
};

function clip(id, start, duration, views, overrides = {}) {
  return {
    id, video_id: vod.id, broadcaster_id: vod.user_id, game_id: '509658',
    vod_offset: start, duration, view_count: views,
    title: `Gameplay moment ${id}`, created_at: '2026-10-18T14:00:00.000Z',
    ...overrides
  };
}

test('selects a non-overlapping set that fills the target duration exactly', () => {
  const result = select15MinuteGameplayHighlights([
    clip('one', 0, 60, 100),
    clip('two', 120, 45, 70),
    clip('three', 240, 45, 60),
    clip('duplicate', 5, 60, 10000)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  assert.equal(result.rejectionReason, null);
  assert.equal(result.highlights.reduce((sum, moment) => sum + moment.duration, 0), 90);
  assert.equal(result.highlights.length, 2);
  const selectedIds = new Set(result.evidence.map((item) => item.clipId));
  assert.equal(selectedIds.has('duplicate') && selectedIds.has('one'), false);
  assert.equal(result.highlights.at(-1).duration >= 15, true);
});

test('prefers a sparse five-minute window when otherwise equal candidates are clustered', () => {
  const result = select15MinuteGameplayHighlights([
    clip('dense-a', 0, 45, 10),
    clip('dense-b', 60, 45, 10),
    clip('sparse', 1200, 45, 10)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  const selectedIds = new Set(result.evidence.map((item) => item.clipId));
  assert.equal(result.rejectionReason, null);
  assert.equal(selectedIds.has('sparse'), true);
  assert.equal(selectedIds.has('dense-a') && selectedIds.has('dense-b'), false);
  assert.equal(result.highlights.reduce((sum, moment) => sum + moment.duration, 0), 90);
});

test('rejects source clips without a Twitch game category as unverified gameplay', () => {
  const result = select15MinuteGameplayHighlights([
    clip('no-game-id', 0, 60, 100, { game_id: '' }),
    clip('valid-but-short', 120, 30, 50)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  assert.equal(result.highlights.length, 0);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
  assert.equal(result.availableGameplaySeconds, 30);
});

test('reports when the VOD has less than fifteen minutes of eligible material', () => {
  const result = select15MinuteGameplayHighlights([
    clip('one', 0, 60, 100), clip('two', 120, 45, 70)
  ], vod);

  assert.deepEqual(result.highlights, []);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
  assert.equal(result.availableGameplaySeconds, 104.8);
  assert.equal(result.targetDurationSeconds, 900);
});

test('rejects overlapping candidates, wrong VODs, invalid lengths and segments outside the VOD', () => {
  const result = select15MinuteGameplayHighlights([
    clip('wrong-vod', 0, 60, 10000, { video_id: '9999' }),
    clip('too-long', 100, 60.1, 10000),
    clip('past-end', 7190, 30, 10000),
    clip('overlap-a', 200, 60, 100),
    clip('overlap-b', 205, 60, 10000)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  assert.equal(result.highlights.length, 0);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
});

