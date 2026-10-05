'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSeoMarket, detectGame } = require('../src/seo-market');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const PUBLIC_SOURCE = { title: 'ARC Raiders match', privacyStatus: 'public', channelId: 'owner-channel' };

function fixture(options = {}) {
  const currentTime = options.currentTime || { value: NOW };
  const snapshots = new Map(options.snapshots || []);
  const savedSnapshots = [];
  const savedBudgets = [];
  let budget = options.budget || null;
  let recentCalls = 0;
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
    recentGameVideos: async () => {
      recentCalls += 1;
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
    calls: () => recentCalls, warnings: () => warnings,
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

test('research is disabled for opt-out, non-public, unknown-game, and incomplete-store cases', async () => {
  const disabled = fixture({ enabled: 'false' });
  const privateVideo = fixture();
  const unknown = fixture();
  const incomplete = fixture({ store: { getSeoMarketBudget: undefined } });
  assert.equal(await disabled.market.research(PUBLIC_SOURCE), null);
  assert.equal(await privateVideo.market.research({ ...PUBLIC_SOURCE, privacyStatus: 'private' }), null);
  assert.equal(await unknown.market.research({ ...PUBLIC_SOURCE, title: 'Unrelated' }), null);
  assert.equal(await incomplete.market.research(PUBLIC_SOURCE), null);
  assert.equal(disabled.calls() + privateVideo.calls() + unknown.calls() + incomplete.calls(), 0);
});

test('reuses a fresh cached sample without spending the daily research budget', async () => {
  const cached = { game: 'ARC Raiders', observedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    samples: [{ id: 'cached-video' }] };
  const state = fixture({ snapshots: [['ARC Raiders', cached]] });
  assert.equal(await state.market.research(PUBLIC_SOURCE), cached);
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
      estimatedViewsPerDay: index * 100, channelId: 'other-channel'
    });
  }
  const state = fixture({ snapshots: [['ARC Raiders', stale]], examples });
  const snapshot = await state.market.research(PUBLIC_SOURCE);
  assert.equal(state.calls(), 1);
  assert.equal(snapshot.samples.length, 5);
  assert.deepEqual(snapshot.samples.map((item) => item.id),
    ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5']);
  assert.equal(snapshot.samples[0].estimatedViewsPerDay, 100);
  assert.deepEqual(Object.keys(snapshot.samples[0]).sort(),
    ['estimatedViewsPerDay', 'id', 'publishedAt', 'title', 'viewCount']);
  assert.equal(state.savedSnapshots.length, 1);
});

test('enforces the three-request UTC-day budget and resets it on the next day', async () => {
  const currentTime = { value: NOW };
  const state = fixture({ currentTime, budget: { date: '2026-10-03', used: 3 },
    examples: [{ id: 'sample', channelId: 'other-channel', viewCount: 20 }] });
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 0);
  currentTime.value = Date.parse('2026-10-04T00:01:00.000Z');
  const result = await state.market.research(PUBLIC_SOURCE);
  assert.equal(result.samples.length, 1);
  assert.deepEqual(state.budget(), { date: '2026-10-04', used: 1 });
  assert.equal(state.calls(), 1);
});

test('fails closed on YouTube research errors and records a warning', async () => {
  const state = fixture({ error: new Error('YouTube unavailable') });
  assert.equal(await state.market.research(PUBLIC_SOURCE), null);
  assert.equal(state.calls(), 1);
  assert.equal(state.budget().used, 1);
  assert.equal(state.warnings(), 1);
});

test('backs off scheduler failures for five minutes instead of retrying on every health check', async () => {
  const currentTime = { value: NOW };
  const state = fixture({
    currentTime,
    youtube: {
      isConnected: async () => true,
      ownedChannel: async () => { throw new Error('invalid_grant'); }
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
