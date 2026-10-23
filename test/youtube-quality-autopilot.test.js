'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualityWindow, isDueForQualityCheck, runYoutubeQualityAutopilot } =
  require('../src/youtube-quality-autopilot');

function publishedHighlight(overrides = {}) {
  return {
    id: 'highlight-1', sourceType: 'twitch_highlight_batch',
    targetHighlightDurationSeconds: 720, duration: 720,
    publicationStatus: 'published', status: 'completed',
    youtubeVideoId: 'abcdefghijk', publishedAt: '2026-10-01T12:00:00.000Z',
    ...overrides
  };
}

function report(summary = [['150', '900', '360', '50']], retention =
  Array.from({ length: 21 }, (_, index) => [index / 20, 0.6])) {
  return { summaryRows: summary, retentionRows: retention,
    engagementRows: [['VIDEO_ON_DEMAND', '125', '150', '900']] };
}

function memoryStore(drafts) {
  const savedStates = [];
  const updates = [];
  return {
    savedStates,
    updates,
    async listDrafts() { return drafts; },
    async updateDraft(id, patch) {
      const draft = drafts.find((item) => item.id === id);
      if (!draft) throw new Error('draft not found');
      Object.assign(draft, patch);
      updates.push({ id, patch });
      return draft;
    },
    async saveSeoSyncState(state) { savedStates.push(state); }
  };
}

test('waits for seven Analytics calendar dates and a three-day reporting delay in Pacific time', () => {
  assert.equal(qualityWindow('2026-10-01T12:00:00Z', new Date('2026-10-11T06:59:59Z')), null);
  assert.deepEqual(qualityWindow('2026-10-01T12:00:00Z', new Date('2026-10-11T07:00:00Z')),
    { startDate: '2026-10-02', endDate: '2026-10-08' });
  assert.deepEqual(qualityWindow('2026-10-02T02:00:00Z', new Date('2026-10-13T07:00:00Z')),
    { startDate: '2026-10-02', endDate: '2026-10-08' });
  assert.equal(qualityWindow('not-a-date', new Date('2026-10-10T00:00:00Z')), null);
});

test('measures mature 12-minute highlights and preserves the 15-minute legacy cohort', async () => {
  const drafts = [
    publishedHighlight(),
    publishedHighlight({ id: 'legacy-15', targetHighlightDurationSeconds: 900, duration: 900 }),
    publishedHighlight({ id: 'short-video', duration: 60 }),
    publishedHighlight({ id: 'scheduled', publicationStatus: 'scheduled', status: 'scheduled' }),
    publishedHighlight({ id: 'awaiting', publicationStatus: 'pending', status: 'awaiting_owner_approval' }),
    publishedHighlight({ id: 'not-publication-marked', publicationStatus: undefined, status: 'completed' }),
    publishedHighlight({ id: 'recent', publishedAt: '2026-10-05T12:00:00Z' }),
    publishedHighlight({ id: 'not-highlight', sourceType: 'twitch_vod' })
  ];
  const store = memoryStore(drafts);
  const measured = [];
  const result = await runYoutubeQualityAutopilot({
    store,
    youtube: {
      async hasAnalyticsReadAccess() { return true; },
      async videoQualityReports(id, start, end) {
        measured.push({ id, start, end });
        return report();
      }
    },
    now: new Date('2026-10-11T14:00:00Z'), logger: { info() {}, warn() {} }
  });
  assert.equal(result.updatedCount, 2);
  assert.deepEqual(measured, [
    { id: 'abcdefghijk', start: '2026-10-02', end: '2026-10-08' },
    { id: 'abcdefghijk', start: '2026-10-02', end: '2026-10-08' }
  ]);
  assert.equal(drafts[0].youtubeQualityAssessment.windowDays, 7);
  assert.equal(drafts[0].youtubeQualityAssessment.status, 'warming_up');
  assert.equal(drafts[0].youtubeQualityAssessment.engagementByContentType[0].engagedViews, 125);
  assert.equal(drafts[0].youtubeQualityRetryAfter, null);
  assert.equal(drafts[1].youtubeQualityAssessment.status, 'warming_up');
});

test('does not read or change drafts until read-only Analytics consent is available', async () => {
  let listCount = 0;
  const result = await runYoutubeQualityAutopilot({
    store: { async listDrafts() { listCount += 1; return []; } },
    youtube: { async hasAnalyticsReadAccess() { return false; } },
    now: new Date('2026-10-10T14:00:00Z')
  });
  assert.equal(result.status, 'needs_youtube_analytics_consent');
  assert.equal(listCount, 0);
});

test('uses the ten prior qualifying highlights to score the current channel band and runs once per day', async () => {
  const older = Array.from({ length: 10 }, (_, index) => publishedHighlight({
    id: 'old-' + index, youtubeVideoId: String(index).padStart(11, '0'),
    publishedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
    youtubeQualityAssessment: { assessedViews: 500, averageViewPercentage: 20 + index,
      relativeRetentionScore: 0.6 },
    youtubeQualityLastCheckedAt: '2026-10-09T12:00:00Z'
  }));
  const current = publishedHighlight({
    youtubeQualityVideoId: undefined, youtubeVideoId: 'zzzzzzzzzzz',
    publishedAt: '2026-10-01T12:00:00Z'
  });
  const legacy = publishedHighlight({ id: 'legacy-15', targetHighlightDurationSeconds: 900,
    duration: 900, youtubeQualityAssessment: { assessedViews: 500, averageViewPercentage: 90,
      relativeRetentionScore: 0.7 }, youtubeQualityLastCheckedAt: '2026-10-09T12:00:00Z' });
  const drafts = [...older, legacy, current];
  const store = memoryStore(drafts);
  let calls = 0;
  const youtube = {
    async hasAnalyticsReadAccess() { return true; },
    async videoQualityReports() { calls += 1; return report([['300', '2400', '600', '45']]); }
  };
  const first = await runYoutubeQualityAutopilot({ store, youtube,
    now: new Date('2026-10-11T14:00:00Z'), logger: { info() {}, warn() {} } });
  assert.equal(first.updatedCount, 1);
  assert.equal(current.youtubeQualityAssessment.channelBand.sampleSize, 10);
  assert.equal(current.youtubeQualityAssessment.status, 'above_ceiling');
  assert.equal(first.state.youtubeQualityAnalyticsRunDate, '2026-10-11');
  const second = await runYoutubeQualityAutopilot({ store, youtube, state: first.state,
    now: new Date('2026-10-11T18:00:00Z'), logger: { info() {}, warn() {} } });
  assert.equal(second.status, 'already_ran_today');
  assert.equal(calls, 1);
});

test('measures Shorts separately and compares only against Shorts of similar duration', async () => {
  const olderShorts = Array.from({ length: 10 }, (_, index) => ({
    id: 'short-' + index, sourceType: 'twitch_highlight_short', duration: 45,
    youtubeVideoId: String(index).padStart(11, '0'), publicationStatus: 'published',
    publishedAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
    youtubeQualityAssessment: { assessedViews: 150, averageViewPercentage: 30 + index,
      relativeRetentionScore: 0.6 },
    youtubeQualityLastCheckedAt: '2026-10-10T12:00:00.000Z'
  }));
  const current = {
    id: 'current-short', sourceType: 'twitch_highlight_short', duration: 50,
    youtubeVideoId: 'zzzzzzzzzzz', publicationStatus: 'published', status: 'completed',
    publishedAt: '2026-10-01T12:00:00.000Z'
  };
  const longHighlight = publishedHighlight({ id: 'long', youtubeVideoId: 'yyyyyyyyyyy',
    targetHighlightDurationSeconds: 720, duration: 720,
    youtubeQualityAssessment: { assessedViews: 1000, averageViewPercentage: 99,
      relativeRetentionScore: 0.99 }, youtubeQualityLastCheckedAt: '2026-10-10T12:00:00.000Z' });
  const drafts = [...olderShorts, longHighlight, current];
  const store = memoryStore(drafts);
  let durationSeen;
  const result = await runYoutubeQualityAutopilot({ store, now: new Date('2026-10-11T14:00:00Z'),
    logger: { info() {}, warn() {} }, youtube: {
      async hasAnalyticsReadAccess() { return true; },
      async videoQualityReports(_id, _start, _end) {
        durationSeen = 50;
        return report([['150', '900', '30', '60']]);
      }
    }});
  assert.equal(result.updatedCount, 1);
  assert.equal(durationSeen, 50);
  assert.equal(current.youtubeQualityAssessment.channelBand.sampleSize, 10);
  assert.equal(current.youtubeQualityAssessment.status, 'above_ceiling');
});

test('retries a transient report failure after six hours without hiding it for a week', async () => {
  const current = publishedHighlight();
  const drafts = [current];
  const store = memoryStore(drafts);
  let calls = 0;
  const youtube = {
    async hasAnalyticsReadAccess() { return true; },
    async videoQualityReports() {
      calls += 1;
      if (calls === 1) throw new Error('temporary analytics outage');
      return report();
    }
  };
  const start = new Date('2026-10-11T14:00:00Z');
  const first = await runYoutubeQualityAutopilot({ store, youtube, now: start,
    logger: { info() {}, warn() {} } });
  assert.equal(first.status, 'retry_scheduled');
  assert.equal(current.youtubeQualityLastCheckedAt, undefined);
  assert.equal(current.youtubeQualityLastError, 'temporary analytics outage');
  assert.equal(isDueForQualityCheck(current, new Date('2026-10-11T19:59:59Z')), false);
  assert.equal(isDueForQualityCheck(current, new Date('2026-10-11T20:00:00Z')), true);
  const recovered = await runYoutubeQualityAutopilot({ store, youtube, state: first.state,
    now: new Date('2026-10-11T20:00:00Z'), logger: { info() {}, warn() {} } });
  assert.equal(recovered.updatedCount, 1);
  assert.equal(current.youtubeQualityLastError, null);
  assert.equal(current.youtubeQualityRetryAfter, null);
  assert.equal(calls, 2);
});

test('pauses after revoked OAuth and resumes after the owner reconnects', async () => {
  const store = memoryStore([publishedHighlight()]);
  let calls = 0;
  const youtube = {
    async hasAnalyticsReadAccess() { return true; },
    async videoQualityReports() { calls += 1; throw new Error('invalid_grant'); }
  };
  const first = await runYoutubeQualityAutopilot({ store, youtube,
    now: new Date('2026-10-11T14:00:00Z'), logger: { info() {}, warn() {} } });
  assert.equal(first.status, 'needs_youtube_reconnect');
  assert.equal(first.state.youtubeQualityAnalyticsNeedsReconnect, true);
  assert.equal(first.state.youtubeQualityAnalyticsRetryAfter, null);
  const waiting = await runYoutubeQualityAutopilot({ store, youtube, state: first.state,
    now: new Date('2026-10-11T20:00:00Z'), logger: { info() {}, warn() {} } });
  assert.equal(waiting.status, 'needs_youtube_reconnect');
  assert.equal(calls, 1);
});
