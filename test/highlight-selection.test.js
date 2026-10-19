'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectGameplayHighlights, summarizeClipQuality } = require('../src/highlight-selection');

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
  const result = selectGameplayHighlights([
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

test('rejects placeholder test streams and test-marked clips before quality ranking', () => {
  const testStream = selectGameplayHighlights([
    clip('real-looking-clip', 0, 60, 1000)
  ], { ...vod, title: 'Test' }, { targetDurationSeconds: 30 });

  assert.equal(testStream.rejectionReason, 'test_stream');
  assert.deepEqual(testStream.highlights, []);

  const testClip = selectGameplayHighlights([
    clip('bot-test-clip', 0, 60, 1000, { title: 'WzBot CLIP | Test (by saevond)' })
  ], vod, { targetDurationSeconds: 30 });

  assert.equal(testClip.rejectionReason, 'no_game_category_clips');
  assert.deepEqual(testClip.highlights, []);
});

test('twelve 60-second live clips can fill the exact 12-minute highlight target', () => {
  const result = selectGameplayHighlights(Array.from({ length: 12 }, (_, index) =>
    clip('live-' + index, index * 180, 60, 0)), vod);

  assert.equal(result.rejectionReason, null);
  assert.equal(result.highlights.length, 12);
  assert.equal(result.highlights.reduce((sum, moment) => sum + moment.duration, 0), 720);
  assert.ok(result.highlights.every((moment) => moment.duration === 60));
});

test('quality floor and ceiling use a robust median/MAD band with enough varied evidence', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ rawQuality: index / 100, viewCount: index }));
  const band = summarizeClipQuality(candidates);
  assert.equal(band.method, 'per_vod_median_mad_capped_at_p90');
  assert.equal(band.calibrated, true);
  assert.equal(band.sampleSize, 30);
  assert.equal(band.floorPercentile, 0.5);
  assert.equal(band.ceilingPercentile, 0.9);
  assert.ok(Math.abs(band.qualityFloor - 0.145) < 1e-9);
  assert.ok(band.qualityCeiling >= band.qualityFloor);
  assert.ok(band.qualityCeiling <= 0.261 + 1e-9);
  assert.ok(band.medianAbsoluteDeviation > 0);
});

test('the median floor selects above-baseline clips and the robust ceiling caps outliers', () => {
  const result = selectGameplayHighlights(Array.from({ length: 40 }, (_, index) =>
    clip('quality-' + index, index * 70, 60, index + 1)), vod);

  assert.equal(result.rejectionReason, null);
  assert.equal(result.highlights.reduce((sum, moment) => sum + moment.duration, 0), 720);
  assert.equal(result.qualityCalibration.method, 'per_vod_median_mad_capped_at_p90');
  assert.equal(result.qualityCalibration.sampleSize, 40);
  assert.ok(result.qualityCalibration.qualifiedCandidateCount < 40);
  assert.ok(result.evidence.every((item) => item.selectionScore >= result.qualityCalibration.qualityFloor * 100 - 1e-8));
  assert.ok(result.evidence.every((item) => item.selectionScore <= result.qualityCalibration.qualityCeiling * 100 + 1e-8));
});

test('weak candidates cannot be used as filler when the floor leaves less than 12 minutes', () => {
  const highStarts = [1350, 1350, 1440, 1440, 1530, 1530, 1620, 1710, 1800, 1890, 1980, 2070, 2160];
  const clips = [
    ...Array.from({ length: 15 }, (_, index) => clip('low-' + index, index * 90, 60, 0)),
    ...highStarts.map((start, index) => clip('high-' + index, start, 60, 10000))
  ];
  const result = selectGameplayHighlights(clips, vod);

  assert.deepEqual(result.highlights, []);
  assert.equal(result.rejectionReason, 'insufficient_quality_gameplay_duration');
  assert.ok(result.qualityCalibration.qualifiedCandidateCount >= 11);
  assert.ok(result.qualityCalibration.qualifiedCandidateCount < clips.length);
  assert.equal(result.availableGameplaySeconds, 660);
  assert.ok(result.unfilteredGameplaySeconds >= 720);
});

test('731-day quality-band simulation stays bounded across low-sample, flat, seasonal, and viral pools', () => {
  const quantile = (values, probability) => {
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const fraction = position - lower;
    return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
  };

  for (let day = 0; day <= 730; day += 1) {
    const sampleSize = day % 53 === 0 ? 25 : 30 + day % 41;
    const candidates = Array.from({ length: sampleSize }, (_, index) => {
      const position = index / Math.max(1, sampleSize - 1);
      const seasonal = 0.03 * Math.sin(day / 19 + index / 7);
      const viralOutlier = day % 11 === 0 && index === sampleSize - 1 ? 0.35 : 0;
      const rawQuality = Math.max(0, Math.min(1, 0.2 + 0.55 * position + seasonal + viralOutlier));
      const viewCount = day % 31 === 0 ? 5
        : day % 17 === 0 ? 0 : Math.round((index + 1) ** 1.8 * (1 + day % 7));
      return { rawQuality, viewCount };
    });
    const band = summarizeClipQuality(candidates);
    const scores = candidates.map((candidate) => candidate.rawQuality);

    assert.ok(Number.isFinite(band.qualityFloor), `day ${day} floor should be finite`);
    assert.ok(Number.isFinite(band.qualityCeiling), `day ${day} ceiling should be finite`);
    assert.ok(band.qualityFloor <= band.qualityCeiling, `day ${day} floor must not exceed ceiling`);
    assert.ok(band.qualityCeiling <= 1, `day ${day} ceiling must stay within the score scale`);
    if (band.calibrated) {
      assert.ok(Math.abs(band.qualityFloor - quantile(scores, 0.5)) < 1e-9,
        `day ${day} floor should equal the same-VOD median`);
      assert.ok(band.qualityCeiling <= quantile(scores, 0.9) + 1e-9,
        `day ${day} ceiling should not exceed the 90th percentile`);
    } else {
      assert.ok(sampleSize < 30 || new Set(candidates.map((candidate) => candidate.viewCount)).size === 1,
        `day ${day} fallback should have a small or flat evidence pool`);
    }
  }
});

test('prefers a sparse five-minute window when otherwise equal candidates are clustered', () => {
  const result = selectGameplayHighlights([
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
  const result = selectGameplayHighlights([
    clip('no-game-id', 0, 60, 100, { game_id: '' }),
    clip('valid-but-short', 120, 30, 50)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  assert.equal(result.highlights.length, 0);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
  assert.equal(result.availableGameplaySeconds, 30);
});

test('reports when the VOD has less than twelve minutes of eligible material', () => {
  const result = selectGameplayHighlights([
    clip('one', 0, 60, 100), clip('two', 120, 45, 70)
  ], vod);

  assert.deepEqual(result.highlights, []);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
  assert.equal(result.availableGameplaySeconds, 105);
  assert.equal(result.targetDurationSeconds, 720);
});

test('rejects overlapping candidates, wrong VODs, invalid lengths and segments outside the VOD', () => {
  const result = selectGameplayHighlights([
    clip('wrong-vod', 0, 60, 10000, { video_id: '9999' }),
    clip('too-long', 100, 60.1, 10000),
    clip('past-end', 7190, 30, 10000),
    clip('overlap-a', 200, 60, 100),
    clip('overlap-b', 205, 60, 10000)
  ], vod, { targetDurationSeconds: 90, minSegmentSeconds: 15 });

  assert.equal(result.highlights.length, 0);
  assert.equal(result.rejectionReason, 'insufficient_non_overlapping_gameplay_duration');
});

