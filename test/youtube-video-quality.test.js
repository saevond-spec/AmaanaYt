'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKET_RETENTION_FLOOR,
  MARKET_RETENTION_CEILING,
  CHANNEL_HISTORY_SIZE,
  youtubeVideoQualityQueries,
  summarizeRelativeRetention,
  summarizeChannelBand,
  summarizeYoutubeVideoQuality
} = require('../src/youtube-video-quality');

function retentionRows(valueAt = () => 0.5) {
  return Array.from({ length: 21 }, (_, index) => [index / 20, valueAt(index / 20)]);
}

function history(values, views = 200) {
  return values.map((averageViewPercentage, index) => ({
    publishedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    averageViewPercentage,
    views
  }));
}

test('requests seven-day video metrics and single-video relative retention with validated IDs and dates', () => {
  assert.deepEqual(youtubeVideoQualityQueries('abcdefghijk', '2026-10-01', '2026-10-07'), [
    { ids: 'channel==MINE', startDate: '2026-10-01', endDate: '2026-10-07',
      filters: 'video==abcdefghijk',
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage' },
    { ids: 'channel==MINE', startDate: '2026-10-01', endDate: '2026-10-07',
      filters: 'video==abcdefghijk', dimensions: 'elapsedVideoTimeRatio',
      metrics: 'relativeRetentionPerformance' }
  ]);
  for (const args of [
    ['invalid', '2026-10-01', '2026-10-07'],
    ['abcdefghijk', '2026-02-30', '2026-03-01'],
    ['abcdefghijk', '2026-10-08', '2026-10-07']
  ]) assert.throws(() => youtubeVideoQualityQueries(...args));
});

test('integrates the full relative-retention curve and interpolates the first-30-second point', () => {
  const result = summarizeRelativeRetention(retentionRows((position) => 0.2 + 0.6 * position), 900);
  assert.equal(result.available, true);
  assert.equal(result.pointCount, 21);
  assert.equal(result.score, 0.5);
  assert.equal(result.introScore, 0.22);
  assert.equal(MARKET_RETENTION_FLOOR, 0.5);
  assert.equal(MARKET_RETENTION_CEILING, 0.75);
});

test('deduplicates curve positions and refuses null, malformed, sparse, and out-of-range points', () => {
  const rows = retentionRows();
  rows.push([0.5, 0.9], [0.5, 0.1], [null, 0.7], [0.7, null], ['bad', 0.4], [0.8, 1.01]);
  const result = summarizeRelativeRetention(rows, 900);
  assert.equal(result.available, true);
  assert.equal(result.pointCount, 21);
  assert.equal(result.score, 0.5);
  assert.equal(summarizeRelativeRetention([[0, 0.5], [1, 0.5]], 900).available, false);
  assert.equal(summarizeRelativeRetention(retentionRows().slice(0, 8), 900).available, false);
  assert.equal(summarizeRelativeRetention(retentionRows(), 0).available, false);
});

test('uses median and robust upper band from ten mature same-channel highlights', () => {
  const prior = history([28, 29, 30, 31, 32, 33, 34, 35, 36, 99]);
  const above = summarizeChannelBand(prior, 40);
  assert.equal(above.calibrated, true);
  assert.equal(above.sampleSize, CHANNEL_HISTORY_SIZE);
  assert.equal(above.floor, 32.5);
  assert.equal(above.ceiling, 38.06);
  assert.equal(above.status, 'above_ceiling');
  assert.equal(summarizeChannelBand(prior, 25).status, 'below_floor');
  assert.equal(summarizeChannelBand(prior, 34).status, 'within_band');
  assert.equal(summarizeChannelBand(prior, null).status, 'unavailable');
  assert.equal(summarizeChannelBand(prior.slice(0, 9), 40).status, 'warming_up');
  assert.equal(summarizeChannelBand(prior.map((item) => ({ ...item, views: 99 })), 40).sampleSize, 0);
});

test('classifies market retention, channel retention, and low-sample results without inventing data', () => {
  const average = summarizeYoutubeVideoQuality([['150', '400', '160', '18']], retentionRows(), {
    history: []
  });
  assert.equal(average.status, 'within_market_band');
  assert.equal(average.assessedViews, 150);
  assert.equal(average.averageViewPercentage, 18);
  assert.equal(average.marketStatus, 'within_market_band');
  assert.equal(average.channelBand.status, 'warming_up');

  const strong = summarizeYoutubeVideoQuality([['150', '1000', '600', '66']],
    retentionRows(() => 0.8), { history: [] });
  assert.equal(strong.status, 'above_market_ceiling');

  const below = summarizeYoutubeVideoQuality([['150', '100', '10', '1']],
    retentionRows(() => 0.3), { history: [] });
  assert.equal(below.status, 'below_market_floor');

  const channel = summarizeYoutubeVideoQuality([['200', '600', '300', '40']], retentionRows(), {
    history: history([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  });
  assert.equal(channel.status, 'above_ceiling');
  assert.equal(channel.channelBand.calibrated, true);

  const noAveragePercentage = summarizeYoutubeVideoQuality([['200', '600', '300', null]], retentionRows(), {
    history: history([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  });
  assert.equal(noAveragePercentage.averageViewPercentage, null);
  assert.equal(noAveragePercentage.status, 'within_market_band');

  const sparse = summarizeYoutubeVideoQuality([['22', null, null, null]], [], { history: [] });
  assert.equal(sparse.status, 'low_sample');
  assert.equal(sparse.averageViewPercentage, null);
  assert.equal(sparse.relativeRetentionScore, null);
  const missing = summarizeYoutubeVideoQuality([[null, null, null, null]], [], { history: [] });
  assert.equal(missing.assessedViews, 0);
  assert.equal(missing.estimatedMinutesWatched, null);
});
