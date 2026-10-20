'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { youtubeQuotaDate, nextYoutubeQuotaReset, isYouTubeDailyQuotaError,
  isYouTubeQuotaError, youtubeQuotaRetryAt, getYouTubeDataApiQuotaBlock,
  isYouTubeDataApiBlocked, recordYouTubeDataApiQuotaBlock, callYouTubeDataApi } = require('../src/youtube-quota');

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


test('linked YouTube quota message is detected as daily quota exhaustion', () => {
  const error = new Error('The request cannot be completed because you have exceeded ' +
    '<a href="/youtube/data/getting-started#quota">quota</a>.');
  const now = Date.parse('2026-10-19T06:00:00Z');
  assert.equal(isYouTubeDailyQuotaError(error), true);
  assert.equal(isYouTubeQuotaError(error), true);
  assert.equal(youtubeQuotaRetryAt(error, now), Date.parse('2026-10-19T07:00:00Z'));
});

test('daily quota pause persists across worker instances, does not shorten, and expires at Pacific reset', async () => {
  let saved = null;
  const store = {
    async getYoutubeDataApiQuotaBlock() { return saved && structuredClone(saved); },
    async saveYoutubeDataApiQuotaBlock(next) {
      if (!saved || Date.parse(saved.blockedUntil) < Date.parse(next.blockedUntil)) saved = structuredClone(next);
      return structuredClone(saved);
    }
  };
  const now = Date.parse('2026-10-19T06:00:00Z');
  const error = new Error('The request cannot be completed because you have exceeded <a>quota</a>.');
  const block = await recordYouTubeDataApiQuotaBlock(store, error, now);
  assert.equal(block.persisted, true);
  assert.equal(block.blockedUntil, Date.parse('2026-10-19T07:00:00Z'));
  assert.equal(await isYouTubeDataApiBlocked(store, now + 1000), true);

  const rateLimited = { response: { status: 403,
    data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } };
  const shorter = await recordYouTubeDataApiQuotaBlock(store, rateLimited, now + 1000);
  assert.equal(shorter.blockedUntil, block.blockedUntil);

  const restartedWorkerStore = {
    async getYoutubeDataApiQuotaBlock() { return structuredClone(saved); }
  };
  const restored = await getYouTubeDataApiQuotaBlock(restartedWorkerStore, now + 1000);
  assert.equal(restored.blockedUntil, block.blockedUntil);
  assert.equal(await getYouTubeDataApiQuotaBlock(restartedWorkerStore, block.blockedUntil), null);
});

test('after a quota response, subsequent Data API calls pause before invoking YouTube again', async () => {
  let saved = null;
  const store = {
    async getYoutubeDataApiQuotaBlock() { return saved && structuredClone(saved); },
    async saveYoutubeDataApiQuotaBlock(next) { saved = structuredClone(next); return structuredClone(saved); }
  };
  const now = Date.parse('2026-10-19T06:00:00Z');
  let calls = 0;
  const quotaError = new Error('The request cannot be completed because you have exceeded quota.');
  await assert.rejects(callYouTubeDataApi(store, async () => {
    calls += 1;
    throw quotaError;
  }, now), /exceeded quota/);
  await assert.rejects(callYouTubeDataApi(store, async () => {
    calls += 1;
  }, now + 1000), /paused until/);
  assert.equal(calls, 1);
});
