const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonetizationWorker } = require('../src/monetization-worker');
const { createSeoMarket, detectGame } = require('../src/seo-market');

test('live monetization updates only eligible public broadcasts on the connected channel', async () => {
  const updated = [];
  const broadcast = (id, privacyStatus, eligible, channelId = 'channel-1',
    lifeCycleStatus = 'live', adsMonetizationStatus = 'off') => ({
    id, snippet: { channelId }, status: { privacyStatus, lifeCycleStatus },
    monetizationDetails: { eligibleForAdsMonetization: eligible, adsMonetizationStatus }
  });
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => ({ id: 'channel-1' }),
    assertTargetChannel: async (id) => assert.equal(id, 'channel-1'),
    listOwnedBroadcasts: async () => [
      broadcast('eligible-public', 'public', true),
      broadcast('private', 'private', true),
      broadcast('unlisted', 'unlisted', true),
      broadcast('other-channel', 'public', true, 'channel-2'),
      broadcast('ended', 'public', true, 'channel-1', 'complete'),
      broadcast('ineligible', 'public', false),
      broadcast('already-on', 'public', true, 'channel-1', 'live', 'on')
    ],
    enablePublicBroadcastAds: async (item) => { updated.push(item.id); }
  };
  const worker = createMonetizationWorker({ youtube,
    env: { YOUTUBE_PUBLIC_LIVE_MONETIZATION: 'true' }, logger: { info() {}, warn() {} } });
  const result = await worker.run();
  assert.deepEqual(updated, ['eligible-public']);
  assert.equal(result.publicBroadcasts, 3);
  assert.equal(result.enabledNow, 1);
  assert.equal(result.ineligible, 1);
  assert.equal(result.alreadyOn, 1);
  const disabled = createMonetizationWorker({ youtube, env: {} });
  assert.equal((await disabled.run()).enabled, false);
  assert.equal(updated.length, 1);
});

test('market samples use fresh public data, exclude the creator, and respect a persistent daily cap', async () => {
  const snapshots = new Map();
  let budget = null;
  const searches = [];
  const store = {
    getSeoMarketSnapshot: async (game) => snapshots.get(game),
    saveSeoMarketSnapshot: async (game, snapshot) => { snapshots.set(game, snapshot); },
    getSeoMarketBudget: async () => budget,
    saveSeoMarketBudget: async (value) => { budget = value; }
  };
  const youtube = { recentGameVideos: async (game) => {
    searches.push(game);
    return [
      { id: 'own', title: 'My ARC Raiders match', channelId: 'channel-1',
        publishedAt: '2026-10-01T00:00:00Z', viewCount: 10 },
      { id: 'other', title: 'ARC Raiders parry gameplay', channelId: 'channel-2',
        publishedAt: '2026-10-01T00:00:00Z', viewCount: 300 }
    ];
  } };
  const options = { store, youtube, env: { SEO_MARKET_RESEARCH: 'true' },
    now: () => Date.parse('2026-10-02T12:00:00Z'), logger: { info() {}, warn() {} } };
  const market = createSeoMarket(options);
  const source = { title: 'ARC Raiders live', privacyStatus: 'public', channelId: 'channel-1' };
  const snapshot = await market.research(source);
  assert.deepEqual(snapshot.samples.map((sample) => sample.id), ['other']);
  assert.equal((await market.research(source)).samples[0].viewCount, 300);
  assert.deepEqual(searches, ['ARC Raiders']);
  assert.equal(await market.research({ ...source, privacyStatus: 'private' }), null);
  assert.equal(detectGame({ title: 'NARAKA Songbird Arena' }), 'NARAKA: BLADEPOINT');
  await market.research({ ...source, title: 'NARAKA Songbird' });
  await market.research({ ...source, title: 'Apex Legends' });
  const restarted = createSeoMarket(options);
  assert.equal(await restarted.research({ ...source, title: 'Mortal Kombat' }), null);
  assert.equal(searches.length, 3);
});

test('live monetization pauses on invalid YouTube OAuth until the owner reconnects', async () => {
  let channelReads = 0;
  const warnings = [];
  const youtube = {
    isConnected: async () => true,
    ownedChannel: async () => {
      channelReads += 1;
      throw new Error('invalid_grant');
    }
  };
  const worker = createMonetizationWorker({
    youtube, env: { YOUTUBE_PUBLIC_LIVE_MONETIZATION: 'true' },
    logger: { info() {}, warn(message) { warnings.push(message); } }
  });

  const result = await worker.run();
  assert.deepEqual(result.errors, ['invalid_grant']);
  assert.equal(worker.status().authorizationBlocked, true);
  worker.schedule();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(channelReads, 1);

  worker.resumeAfterYouTubeReconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(channelReads, 2);
  assert.equal(worker.status().authorizationBlocked, true);
  assert.equal(warnings.filter((message) => message.includes('reconnect YouTube')).length, 2);
});