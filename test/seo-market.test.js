'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSeoMarket, detectGame, durationBand, summarizeMarketSamples } = require('../src/seo-market');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const PUBLIC_SOURCE = { title: 'ARC Raiders match', privacyStatus: 'public', channelId: 'owner-channel',
  durationSeconds: 900 };

function marketSample(index, durationSeconds = 900) {
  return { id: 'sample-' + index, title: 'ARC Raiders solo extraction ' + (index % 3),
    channelId: 'market-channel-' + index, publishedAt: '2026-10-02T12:00:00.000Z',
    viewCount: index * 100, durationSeconds };
}

function fixture(options = {}) {
  const currentTime = options.currentTime || { value: NOW };
  const snapshots = new Map(options.snapshots || []);
  const savedSnapshots = [];
  const savedBudgets = [];
  let budget = options.budget || null;
  let recentCalls = 0;
  let requestedGame = null;
  let warnings = 0;
  const store = {
    getSeoMarketSnapshot: async (game) => snapshots.get(game) || null,
    saveSeoMarketSnapshot: async (game, snapshot) => {
      snapshots.set(game, snapshot);
      savedSnapshots.push(snapshot);
    },
    getSeoMarketBudget: async () => budget,
    saveSeoMarketBudget: async (next) => {
      budget = next;
      savedBudgets.push(next);
    },
    ...(options.store || {})
  };
  const youtube = {
    recentGameVideos: async (game) => {
      recentCalls += 1;
      requestedGame = game;
      if (options.error) throw options.error;
      return options.examples || [];
    },
    ...(options.youtube || {})
  };
  const market = createSeoMarket({
    store,
    youtube,
    env: { SEO_MARKET_RESEARCH: options.enabled === undefined ? 'true' : options.enabled },
    now: () => currentTime.value,
    logger: { info() {}, warn() { warnings += 1; } }
  });
  return {
    market, snapshots, savedSnapshots, savedBudgets, currentTime,
    calls: () => recentCalls, requestedGame: () => requestedGame, warnings: () => warnings,
    budget: () => budget
  };
}

test('detects recognized games from title or a bounded description and ignores unrelated videos', () => {
  assert.equal(detectGame({ title: 'Late game ARC Raiders fight' }), 'ARC Raiders');
  assert.equal(detectGame({ title: 'Match', description: 'NARAKA: BLADEPOINT parry practice' }),
    'NARAKA: BLADEPOINT');
  assert.equal(detectGame({ title: 'Unrelated gameplay', description: 'A cozy building stream' }), null);
  assert.equal(detectGame({ title: 'Unrelated', description: 'x'.repeat(251) + ' ARC Raiders' }), null);
});

test('duration cohorts describe comparable lengths without guessing a YouTube format', () => {
  assert.equal(durationBand(180), 'up_to_3_minutes');
  assert.equal(durationBand(181), '3_to_15_minutes');
  assert.equal(durationBand(900), '3_to_15_minutes');
  assert.equal(durationBand(901), '15_to_60_minutes');
  assert.equal(durationBand(null), null);
});

test('research is disabled for opt-out, unknown-game, and incomplete-store cases; private uploads use only the game query', async () => {
  const disabled = fixture({ enabled: 'false' });
  const privateVideo = fixture();
  const unknown = fixture();
  const incomplete = fixture({ store: { getSeoMarketBudget: undefined } });
  assert.equal(await disabled.market.research(PUBLIC_SOURCE), null);
  assert.equal(await privateVideo.market.research({ ...PUBLIC_SOURCE, privacyStatus: 'private' }), null);
  assert.equal(await unknown.market.research({ ...PUBLIC_SOURCE, title: 'Unrelated' }), null);
  assert.equal(await incomplete.market.research(PUBLIC_SOURCE), null);
  assert.equal(disabled.calls() + privateVideo.calls() + unknown.calls() + incomplete.calls(), 1);
  assert.equal(privateVideo.requestedGame(), 'ARC Raiders');
});

test('reuses fresh raw examples for a comparable length cohort without spending research budget', async () => {
  const cached = { game: 'ARC Raiders', observedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    rawSamples: Array.from({ length: 8 }, (_value, index) => marketSample(index + 1)) };
  const state = fixture({ snapshots: [['ARC Raiders', cached]] });
  const result = await state.market.research(PUBLIC_SOURCE);
  assert.equal(result.metrics.durationBand, '3_to_15_minutes');
  assert.equal(result.metrics.sampleCount, 8);
  assert.equal(state.calls(), 0);
  assert.deepEqual(state.savedBudgets, []);
});

test('refreshes stale samples, excludes the owner channel, caps examples at five, and preserves velocity', async () => {
  const stale = { game: 'ARC Raiders', observedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(),
    samples: [{ id: 'old' }] };
  const examples = [{ id: 'owner-video', channelId: 'owner-channel', viewCount: 99 }];
  for (let index = 1; index <= 6; index += 1) {
    examples.push({
      id: 'sample-' + index, title: 'Example ' + index,
      publishedAt: '2026-10-02T12:00:00.000Z', viewCount: index * 100,
      estimatedViewsPerDay: index * 100, channelId: 'other-channel-' + index, durationSeconds: 900
    });
  }
  const state = fixture({ snapshots: [['ARC Raiders', stale]], examples });
  const snapshot = await state.market.research(PUBLIC_SOURCE);
  assert.equal(state.calls(), 1);
  assert.equal(snapshot.samples.length, 5);
  assert.deepEqual(snapshot.samples.map((item) => item.id),
    ['sample-6', 'sample-5', 'sample-4', 'sample-3', 'sample-2']);
  assert.equal(snapshot.samples[0].estimatedViewsPerDay, 600);
  assert.deepEqual(snapshot.sampleDesign, ['publishedAt', 'viewCount', 'durationSeconds']);
  assert.deepEqual(snapshot.viewMetricSemantics,
    { metric: 'public_views', definitionSince: '2026-08-24' });
  assert.equal(snapshot.metrics.sampleCount, 6);
  assert.ok(snapshot.samples[0].smoothedViewsPerDay > 0);
  assert.ok(snapshot.metrics.confidence > 0);
  assert.deepEqual(Object.keys(snapshot.samples[0]).sort(),
    ['durationSeconds', 'estimatedViewsPerDay', 'id', 'publishedAt', 'smoothedViewsPerDay', 'title', 'velocityIndex', 'viewCount']);
  assert.equal(state.savedSnapshots.length, 1);
});

test('enforces the three-query Pacific quota-day budget and resets at midnight Pacific', async () => {
  const currentTime = { value: NOW };
  const state = fixture({ currentTime, budget: { date: '2026-10-03', used: 3 },
    examples: [{ id: 'sample', title: 'ARC Raiders gameplay', channelId: 'other-channel',
      publishedAt: '2026-10-03T00:00:00.000Z', viewCount: 20, durationSeconds: 900 }] });
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 0);
  currentTime.value = Date.parse('2026-10-04T07:01:00.000Z');
  const result = await state.market.research(PUBLIC_SOURCE);
  assert.equal(result.samples.length, 1);
  assert.deepEqual(state.budget(), { date: '2026-10-04', used: 1 });
  assert.equal(state.calls(), 1);
});

test('market ranking shrinks new-view spikes and reports robust spread without claiming phrase causality', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const examples = [
    { id: 'new-spike', channelId: 'creator-1', title: 'ARC Raiders solo extraction', publishedAt: '2026-10-07T11:00:00Z', viewCount: 600, durationSeconds: 900 },
    { id: 'steady-one', channelId: 'creator-2', title: 'ARC Raiders solo extraction guide', publishedAt: '2026-10-04T12:00:00Z', viewCount: 900, durationSeconds: 900 },
    { id: 'steady-two', channelId: 'creator-3', title: 'ARC Raiders solo fight', publishedAt: '2026-10-04T12:00:00Z', viewCount: 600, durationSeconds: 900 },
    { id: 'steady-three', channelId: 'creator-4', title: 'ARC Raiders squad gameplay', publishedAt: '2026-10-04T12:00:00Z', viewCount: 300, durationSeconds: 900 }
  ];
  const summary = summarizeMarketSamples(examples, { now, game: 'ARC Raiders', durationSeconds: 900 });
  assert.equal(summary.metrics.sampleCount, 4);
  assert.equal(summary.metrics.priorDays, 2);
  assert.equal(summary.metrics.priorViewsPerDay, 250);
  assert.equal(summary.metrics.medianViewsPerDay, 250);
  assert.equal(summary.samples[0].id, 'new-spike');
  assert.equal(summary.samples[0].smoothedViewsPerDay, 539);
  assert.ok(summary.samples[0].smoothedViewsPerDay < summary.samples[0].estimatedViewsPerDay);
  assert.ok(summary.metrics.medianAbsoluteDeviation > 0);
  assert.ok(summary.metrics.confidence > 0 && summary.metrics.confidence < 1);
  assert.deepEqual(summary.terms, []);
  assert.equal(summary.metrics.phraseSuggestionsEligible, false);
  assert.equal(summary.metrics.phraseSuggestionReason, 'too_few_comparable_samples');
});

test('market phrase suggestions require repeated support across a comparable same-game length cohort', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const samples = Array.from({ length: 10 }, (_value, index) => ({
    ...marketSample(index + 1, index === 9 ? 1200 : 900),
    title: index < 4 ? 'ARC Raiders solo extraction guide' : 'ARC Raiders ranked match',
    publishedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000).toISOString()
  }));
  const summary = summarizeMarketSamples(samples, { now, game: 'ARC Raiders', durationSeconds: 900 });
  assert.equal(summary.metrics.sampleCount, 9);
  assert.equal(summary.metrics.comparisonBasis, 'same_game_and_duration_band');
  assert.equal(summary.metrics.phraseSuggestionsEligible, true);
  assert.ok(summary.terms.some((term) => term.phrase === 'solo extraction' && term.sampleCount >= 3));
  assert.ok(summary.terms.every((term) => Number.isFinite(term.score) && term.score >= 0));
  assert.ok(summary.samples.every((item) => item.durationSeconds === 900));
});

test('repeated uploads from one channel do not inflate distinct-channel phrase support', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const samples = Array.from({ length: 10 }, (_value, index) => ({
    ...marketSample(index + 1), channelId: 'one-creator', viewCount: index + 1,
    title: 'ARC Raiders solo extraction guide',
    publishedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000).toISOString()
  }));
  const summary = summarizeMarketSamples(samples, { now, game: 'ARC Raiders', durationSeconds: 900 });
  assert.equal(summary.metrics.sampleCount, 10);
  assert.equal(summary.metrics.distinctChannelCount, 1);
  assert.equal(summary.metrics.positiveViewChannelCount, 1);
  assert.equal(summary.metrics.phraseSuggestionReason, 'too_few_distinct_channels');
  assert.equal(summary.metrics.phraseSuggestionsEligible, false);
  assert.ok(summary.metrics.confidence <= 0.167, 'rounded score is capped by one independent channel');
  assert.equal(summary.terms.length, 0);
});

test('all-zero results and repeated result IDs cannot create phrase suggestions', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const zeroResults = Array.from({ length: 10 }, (_value, index) => ({
    ...marketSample(index + 1), viewCount: 0, title: 'ARC Raiders solo extraction guide',
    publishedAt: new Date(now - (index + 1) * 24 * 60 * 60 * 1000).toISOString()
  }));
  const zeros = summarizeMarketSamples(zeroResults, { now, game: 'ARC Raiders', durationSeconds: 900 });
  assert.equal(zeros.metrics.positiveViewChannelCount, 0);
  assert.equal(zeros.metrics.phraseSuggestionReason, 'too_few_positive_view_channels');
  assert.equal(zeros.metrics.phraseSuggestionsEligible, false);

  const duplicate = summarizeMarketSamples([marketSample(1), marketSample(1)], {
    now: Date.parse('2026-10-03T12:00:00Z'), game: 'ARC Raiders', durationSeconds: 900
  });
  assert.equal(duplicate.metrics.sampleCount, 1);
  assert.equal(duplicate.metrics.distinctChannelCount, 1);
});

test('missing, malformed, fractional and unsafe public counts are excluded instead of coerced to zero', () => {
  const now = Date.parse('2026-10-07T12:00:00Z');
  const invalidCounts = [null, '', undefined, '1,2', -1, 1.5, 1e308, '9'.repeat(100)];
  const samples = [
    { ...marketSample(101), channelId: 'zero-number', viewCount: 0 },
    { ...marketSample(102), channelId: 'zero-string', viewCount: '0' },
    { ...marketSample(103), channelId: 'valid-grouped', viewCount: '1,000' },
    ...invalidCounts.map((viewCount, index) => ({ ...marketSample(index + 104), viewCount })),
    { ...marketSample(200), id: '', channelId: 'missing-id-channel', viewCount: 99 }
  ];
  const summary = summarizeMarketSamples(samples, { now, game: 'ARC Raiders', durationSeconds: 900 });
  assert.equal(summary.metrics.sampleCount, 3);
  assert.equal(summary.metrics.positiveViewChannelCount, 1);
  assert.deepEqual(summary.samples.map((sample) => sample.viewCount), [1000, 0, 0]);
  assert.ok(Number.isFinite(summary.metrics.medianViewsPerDay));
});

test('fails closed on YouTube research errors and records a warning', async () => {
  const state = fixture({ error: new Error('YouTube unavailable') });
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 1);
  assert.equal(state.budget().used, 1);
  assert.equal(state.warnings(), 1);
});

test('daily YouTube quota failures persist a Pacific-midnight cooldown and suppress repeated market calls', async () => {
  const currentTime = { value: Date.parse('2026-10-03T12:00:00.000Z') };
  let savedState = null;
  const state = fixture({ currentTime,
    error: Object.assign(new Error('YouTube daily quota exceeded'), {
      response: { status: 403, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } }
    }),
    store: {
      getSeoSyncState: async () => ({}),
      saveSeoSyncState: async (next) => { savedState = next; }
    }
  });

  await state.market.research(PUBLIC_SOURCE);
  assert.equal(state.calls(), 1);
  assert.equal(savedState.youtubeDataApiBlockReason, 'YouTube Data API daily quota exceeded');
  assert.equal(savedState.youtubeDataApiBlockedUntil,
    new Date(Date.parse('2026-10-04T07:00:00Z')).toISOString());
  currentTime.value += 60 * 1000;
  await state.market.research(PUBLIC_SOURCE);
  assert.equal(state.calls(), 1);
});

test('backs off ordinary scheduler failures for five minutes instead of retrying on every health check', async () => {
  const currentTime = { value: NOW };
  const state = fixture({
    currentTime,
    youtube: {
      isConnected: async () => true,
      ownedChannel: async () => { throw new Error('YouTube unavailable'); }
    }
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  state.market.schedule();
  await flush();
  assert.equal(state.warnings(), 1);

  state.market.schedule();
  await flush();
  assert.equal(state.warnings(), 1);

  currentTime.value += 5 * 60 * 1000;
  state.market.schedule();
  await flush();
  assert.equal(state.warnings(), 2);
});

test('backs off invalid_grant and clears the hold after reconnect', async () => {
  const currentTime = { value: NOW };
  const state = fixture({ currentTime, error: new Error('invalid_grant') });
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 1);
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 1);

  state.market.resetBackoff();
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 2);
});
