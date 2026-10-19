'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { youtubeQuotaDate, nextYoutubeQuotaReset, isYouTubeDailyQuotaError,
  isYouTubeQuotaError, youtubeQuotaRetryAt } = require('../src/youtube-quota');

test('YouTube quota day and reset use Pacific midnight through daylight-saving changes', () => {
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-19T06:59:00Z')), '2026-10-18');
  assert.equal(nextYoutubeQuotaReset(Date.parse('2026-10-19T06:59:00Z')),
    Date.parse('2026-10-19T07:00:00Z'));
  assert.equal(nextYoutubeQuotaReset(Date.parse('2026-03-08T08:30:00Z')),
    Date.parse('2026-03-09T07:00:00Z'));
  assert.equal(nextYoutubeQuotaReset(Date.parse('2026-11-01T08:30:00Z')),
    Date.parse('2026-11-02T08:00:00Z'));
});

test('YouTube quota errors are distinguished from short rate limits', () => {
  const daily = { response: { status: 403, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } } };
  const rate = { response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } };
  const now = Date.parse('2026-10-19T06:00:00Z');
  assert.equal(isYouTubeDailyQuotaError(daily), true);
  assert.equal(isYouTubeQuotaError(daily), true);
  assert.equal(youtubeQuotaRetryAt(daily, now), Date.parse('2026-10-19T07:00:00Z'));
  assert.equal(isYouTubeDailyQuotaError(rate), false);
  assert.equal(isYouTubeQuotaError(rate), true);
  assert.equal(youtubeQuotaRetryAt(rate, now), now + 5 * 60 * 1000);
  assert.equal(isYouTubeQuotaError(new Error('Video is private')), false);
});
