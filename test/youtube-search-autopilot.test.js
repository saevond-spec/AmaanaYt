const { test } = require('node:test');
const assert = require('node:assert/strict');
const { youtubeSearchComparisonWindows, isGoogleExternalReferrer, hasYoutubeAnalyticsReadScopes,
  youtubeSearchReportQueries, summarizeYoutubeSearchPerformance } = require('../src/youtube-search-performance');
const { runYoutubeSearchAutopilot, safeCursor, isYoutubeAnalyticsApiDisabledError } =
  require('../src/youtube-search-autopilot');

test('recognizes YouTube Analytics service-disabled errors for recovery checks', () => {
  assert.equal(isYoutubeAnalyticsApiDisabledError(
    'YouTube Analytics API has not been used in project 878027589263 before or it is disabled.'), true);
  assert.equal(isYoutubeAnalyticsApiDisabledError({ response: { data: {
    error: { status: 'SERVICE_DISABLED', message: 'API disabled' }
  } } }), true);
  assert.equal(isYoutubeAnalyticsApiDisabledError('quota exceeded'), false);
});

test('requests owner-scoped source-type and capped external-detail reports with read-only scopes', () => {
  const scopes = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly';
  assert.equal(hasYoutubeAnalyticsReadScopes({ refresh_token: 'redacted', scope: scopes }), true);
  assert.equal(hasYoutubeAnalyticsReadScopes({ refresh_token: 'redacted',
    scope: 'https://www.googleapis.com/auth/youtube.readonly' }), false);
  assert.deepEqual(youtubeSearchReportQueries('abcdefghijk', '2026-09-05', '2026-10-02'), [
    { ids: 'channel==MINE', startDate: '2026-09-05', endDate: '2026-10-02', metrics: 'views',
      dimensions: 'insightTrafficSourceType', filters: 'video==abcdefghijk', sort: '-views' },
    { ids: 'channel==MINE', startDate: '2026-09-05', endDate: '2026-10-02', metrics: 'views',
      dimensions: 'insightTrafficSourceDetail',
      filters: 'video==abcdefghijk;insightTrafficSourceType==EXT_URL', sort: '-views', maxResults: 25 }
  ]);
  assert.throws(() => youtubeSearchReportQueries('invalid', '2026-09-05', '2026-10-02'));
});

test('uses adjacent 28-day windows and leaves the newest three days out', () => {
  assert.deepEqual(youtubeSearchComparisonWindows(new Date('2026-10-05T18:30:00.000Z')), {
    current: { startDate: '2026-09-05', endDate: '2026-10-02' },
    previous: { startDate: '2026-08-08', endDate: '2026-09-04' }
  });
  assert.equal(safeCursor(38, 40), 38);
  assert.equal(safeCursor(42, 40), 2);
  assert.equal(safeCursor(-1, 40), 0);
});

test('recognizes Google Search details without matching lookalike hosts', () => {
  assert.equal(isGoogleExternalReferrer('https://www.google.com/search?q=game'), true);
  assert.equal(isGoogleExternalReferrer('google.co.uk'), true);
  assert.equal(isGoogleExternalReferrer('Google Search'), true);
  assert.equal(isGoogleExternalReferrer('googleusercontent.com'), false);
  assert.equal(isGoogleExternalReferrer('googlevideo.com'), false);
  assert.equal(isGoogleExternalReferrer('https://bing.com/search'), false);
  assert.equal(isGoogleExternalReferrer('not a URL'), false);
});

test('separates Google external views and marks 25-row detail results incomplete', () => {
  assert.deepEqual(summarizeYoutubeSearchPerformance(
    [['YT_SEARCH', '12'], ['EXT_URL', '7']], [['www.google.com', '4'], ['bing.com', '3']]
  ), { youtubeSearchViews: 12, googleSearchReferralViews: 4,
    googleSearchReferralComplete: true, googleSearchDetailRows: 2 });
  const cappedWithoutGoogle = summarizeYoutubeSearchPerformance(
    [['YT_SEARCH', 0]], Array.from({ length: 25 }, (_, index) => ['other' + index + '.com', '1']));
  assert.equal(cappedWithoutGoogle.googleSearchReferralViews, null);
  assert.equal(cappedWithoutGoogle.googleSearchReferralComplete, false);
  const cappedWithGoogle = summarizeYoutubeSearchPerformance([], Array.from({ length: 25 }, (_, index) =>
    [index === 0 ? 'google.com' : 'other' + index + '.com', String(index + 2)]));
  assert.equal(cappedWithGoogle.googleSearchReferralViews, 2);
  assert.equal(cappedWithGoogle.googleSearchReferralComplete, false);
});

test('rejects missing, coerced, fractional, negative, and overflowing Analytics counts', () => {
  for (const value of [null, undefined, '', '  ', '1.5', '-1', '1e2', false, NaN, Infinity]) {
    assert.throws(() => summarizeYoutubeSearchPerformance([['YT_SEARCH', value]], []),
      /invalid YouTube Search view count/);
  }
  assert.equal(summarizeYoutubeSearchPerformance([['YT_SEARCH', 0], ['YT_SEARCH', '12']], [])
    .youtubeSearchViews, 12);
  assert.throws(() => summarizeYoutubeSearchPerformance([
    ['YT_SEARCH', Number.MAX_SAFE_INTEGER], ['YT_SEARCH', 1]
  ], []), /invalid YouTube Search view total/);
});

test('autopilot runs one rotating low-view-first batch per day and saves equal windows', async () => {
  const requests = [];
  const saved = [];
  const storeApi = {
    async countPublicSeoVideos() { return 45; },
    async listYoutubeSearchCandidates(limit, offset) {
      requests.push({ limit, offset });
      return ['abcdefghijk', 'bbbbbbbbbbb', 'ccccccccccc'].map((videoId) => ({ videoId }));
    },
    async saveYoutubeSearchSnapshots(rows) { saved.push(rows); },
    async saveSeoSyncState() {}
  };
  const youtubeApi = {
    async hasAnalyticsReadAccess() { return true; },
    async googleSearchTraffic(videoId, startDate, endDate) {
      return { googleSearchReferralViews: 2, googleSearchReferralComplete: true,
        googleSearchDetailRows: 1, youtubeSearchViews: 9, videoId, startDate, endDate };
    }
  };
  const now = new Date('2026-10-05T18:30:00.000Z');
  const first = await runYoutubeSearchAutopilot({ store: storeApi, youtube: youtubeApi, now, batchSize: 3,
    logger: { info() {}, warn() {} } });
  assert.equal(first.status, 'complete');
  assert.equal(first.updatedCount, 3);
  assert.deepEqual(requests[0], { limit: 3, offset: 0 });
  assert.equal(saved.length, 3);
  assert.equal(saved[0].length, 2);
  assert.equal(saved[0][0].startDate, '2026-09-05');
  assert.equal(saved[0][1].endDate, '2026-09-04');
  assert.equal(first.state.youtubeSearchAnalyticsCursor, 3);
  const sameDay = await runYoutubeSearchAutopilot({ store: storeApi, youtube: youtubeApi,
    now, state: first.state, logger: { info() {}, warn() {} } });
  assert.equal(sameDay.status, 'already_ran_today');
  const nextDay = await runYoutubeSearchAutopilot({ store: storeApi, youtube: youtubeApi,
    now: new Date('2026-10-06T12:00:00.000Z'), state: first.state, batchSize: 3,
    logger: { info() {}, warn() {} } });
  assert.deepEqual(requests[1], { limit: 3, offset: 3 });
  assert.equal(nextDay.state.youtubeSearchAnalyticsCursor, 6);
});

test('autopilot waits for read-only consent and schedules a cooldown after total failure', async () => {
  let counted = 0;
  const storeApi = {
    async countPublicSeoVideos() { counted += 1; return 1; },
    async listYoutubeSearchCandidates() { return [{ videoId: 'abcdefghijk' }]; },
    async saveYoutubeSearchSnapshots() {},
    async saveSeoSyncState() {}
  };
  const denied = await runYoutubeSearchAutopilot({ store: storeApi,
    youtube: { async hasAnalyticsReadAccess() { return false; } },
    now: new Date('2026-10-05T18:30:00.000Z') });
  assert.equal(denied.status, 'needs_youtube_analytics_consent');
  assert.equal(counted, 0);
  const failed = await runYoutubeSearchAutopilot({ store: storeApi,
    youtube: { async hasAnalyticsReadAccess() { return true; },
      async googleSearchTraffic() { throw new Error('permission denied'); } },
    now: new Date('2026-10-05T18:30:00.000Z'),
    logger: { info() {}, warn() {} } });
  assert.equal(failed.status, 'retry_scheduled');
  assert.equal(failed.failedCount, 1);
  assert.equal(Date.parse(failed.state.youtubeSearchAnalyticsRetryAfter),
    Date.parse('2026-10-06T00:30:00.000Z'));
  assert.equal(failed.state.youtubeSearchAnalyticsRunDate, null);
});

test('startup recovery bypasses one stale cooldown only for the disabled Analytics API error', async () => {
  const now = new Date('2026-10-05T18:30:00.000Z');
  const state = {
    youtubeSearchAnalyticsRetryAfter: '2026-10-05T23:00:00.000Z',
    youtubeSearchAnalyticsLastError: 'abcdefghijk: YouTube Analytics API has not been used in project 878027589263 before or it is disabled.'
  };
  let calls = 0;
  const store = {
    async countPublicSeoVideos() { return 1; },
    async listYoutubeSearchCandidates() { return [{ videoId: 'abcdefghijk' }]; },
    async saveYoutubeSearchSnapshots() {},
    async saveSeoSyncState(next) { this.state = next; }
  };
  const youtube = {
    async hasAnalyticsReadAccess() { return true; },
    async googleSearchTraffic() {
      calls += 1;
      return { youtubeSearchViews: 1, googleSearchReferralViews: 0,
        googleSearchReferralComplete: true, googleSearchDetailRows: 0 };
    }
  };
  const cooling = await runYoutubeSearchAutopilot({ store, youtube, state, now,
    logger: { info() {}, warn() {} } });
  assert.equal(cooling.status, 'cooldown');
  assert.equal(calls, 0);

  const recovered = await runYoutubeSearchAutopilot({ store, youtube, state, now,
    retryDisabledApiOnStartup: true, logger: { info() {}, warn() {} } });
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.updatedCount, 1);
  assert.equal(calls, 2);
  assert.equal(recovered.state.youtubeSearchAnalyticsLastError, null);
  assert.equal(recovered.state.youtubeSearchAnalyticsRetryAfter, null);
  assert.equal(recovered.state.youtubeSearchAnalyticsRunDate, '2026-10-05');

  const unrelatedError = await runYoutubeSearchAutopilot({ store, youtube,
    state: { ...state, youtubeSearchAnalyticsLastError: 'quota exceeded' }, now,
    retryDisabledApiOnStartup: true, logger: { info() {}, warn() {} } });
  assert.equal(unrelatedError.status, 'cooldown');
  assert.equal(calls, 2);
});

test('autopilot pauses on revoked OAuth, preserves its cursor, and retries after reconnect', async () => {
  let calls = 0;
  let savedState;
  const storeApi = {
    async countPublicSeoVideos() { return 10; },
    async listYoutubeSearchCandidates() {
      return ['abcdefghijk', 'bbbbbbbbbbb', 'ccccccccccc'].map((videoId) => ({ videoId }));
    },
    async saveYoutubeSearchSnapshots() {},
    async saveSeoSyncState(state) { savedState = state; }
  };
  const youtube = {
    async hasAnalyticsReadAccess() { return true; },
    async googleSearchTraffic() { calls += 1; throw new Error('invalid_grant'); }
  };
  const failed = await runYoutubeSearchAutopilot({ store: storeApi, youtube,
    state: { youtubeSearchAnalyticsCursor: 4 }, batchSize: 3,
    now: new Date('2026-10-05T18:30:00.000Z'), logger: { info() {}, warn() {} } });
  assert.equal(failed.status, 'needs_youtube_reconnect');
  assert.equal(calls, 2);
  assert.equal(failed.state.youtubeSearchAnalyticsAttempted, 1);
  assert.equal(failed.state.youtubeSearchAnalyticsCursor, 4);
  assert.equal(failed.state.youtubeSearchAnalyticsNeedsReconnect, true);
  assert.equal(failed.state.youtubeSearchAnalyticsRetryAfter, null);
  assert.equal(failed.state.youtubeSearchAnalyticsRunDate, null);
  assert.equal(savedState, failed.state);

  const waiting = await runYoutubeSearchAutopilot({ store: storeApi, youtube,
    state: failed.state, now: new Date('2026-10-05T19:00:00.000Z'),
    logger: { info() {}, warn() {} } });
  assert.equal(waiting.status, 'needs_youtube_reconnect');
  assert.equal(calls, 2);
});

test('autopilot records an empty window without fabricating metrics', async () => {
  const states = [];
  const result = await runYoutubeSearchAutopilot({
    store: {
      async countPublicSeoVideos() { return 0; },
      async listYoutubeSearchCandidates() { throw new Error('must not query an empty catalog'); },
      async saveYoutubeSearchSnapshots() {},
      async saveSeoSyncState(state) { states.push(state); }
    },
    youtube: { async hasAnalyticsReadAccess() { return true; } },
    now: new Date('2026-10-05T18:30:00.000Z')
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.updatedCount, 0);
  assert.equal(result.state.youtubeSearchAnalyticsRunDate, '2026-10-05');
  assert.equal(states.length, 1);
});

test('a nonempty public catalog with an empty candidate page stays incomplete and retries', async () => {
  const now = new Date('2026-10-05T18:30:00.000Z');
  const states = [];
  let analyticsCalls = 0;
  const store = {
    async countPublicSeoVideos() { return 12; },
    async listYoutubeSearchCandidates() { return []; },
    async saveYoutubeSearchSnapshots() { throw new Error('no snapshots should be written'); },
    async saveSeoSyncState(state) { states.push(state); }
  };
  const result = await runYoutubeSearchAutopilot({ store,
    youtube: {
      async hasAnalyticsReadAccess() { return true; },
      async googleSearchTraffic() { analyticsCalls += 1; }
    }, state: { youtubeSearchAnalyticsCursor: 4 }, now,
    logger: { info() {}, warn() {} } });

  assert.equal(result.status, 'retry_scheduled');
  assert.equal(result.candidatePageEmpty, true);
  assert.equal(result.state.youtubeSearchAnalyticsCursor, 4);
  assert.equal(result.state.youtubeSearchAnalyticsRunDate, null);
  assert.equal(result.state.youtubeSearchAnalyticsAttempted, 0);
  assert.equal(result.state.youtubeSearchAnalyticsUpdated, 0);
  assert.equal(Date.parse(result.state.youtubeSearchAnalyticsRetryAfter), now.getTime() + 60 * 60 * 1000);
  assert.match(result.state.youtubeSearchAnalyticsLastError, /candidate page was empty/);
  assert.equal(analyticsCalls, 0);
  assert.equal(states.length, 1);
});
