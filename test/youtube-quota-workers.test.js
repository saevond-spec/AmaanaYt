'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannelTagWorker } = require('../src/channel-tag-worker');
const { createMonetizationWorker } = require('../src/monetization-worker');
const { createJapaneseLocalizationWorker } = require('../src/japanese-localization-worker');
const { createPlaylistAutoAssigner } = require('../src/playlist-auto');
const { createSeoMarket } = require('../src/seo-market');
const { createShortViewMonitor } = require('../src/short-views');
const { createSeoWorker } = require('../src/seo-worker');
const { recordYouTubeDataApiQuotaBlock } = require('../src/youtube-quota');

const BLOCKED_UNTIL = '2099-01-01T00:00:00.000Z';

function blockedStore(extra = {}) {
  return {
    async getYoutubeDataApiQuotaBlock() {
      return { blockedUntil: BLOCKED_UNTIL, reason: 'YouTube Data API daily quota exceeded' };
    },
    async saveYoutubeDataApiQuotaBlock(value) { return value; },
    async getSeoSyncState() { return {}; },
    async saveSeoSyncState() {},
    ...extra
  };
}

function countedYoutube() {
  const calls = [];
  const youtube = new Proxy({}, {
    get(_target, property) {
      if (property === 'isConnected' || property === 'hasAnalyticsReadAccess') {
        return async () => { calls.push(property); return true; };
      }
      return async () => { calls.push(property); return []; };
    }
  });
  return { youtube, calls };
}

test('creator tags and live monetization skip YouTube calls during a persisted quota pause', async () => {
  const store = blockedStore();
  const tagYoutube = countedYoutube();
  const tagWorker = createChannelTagWorker({ store, youtube: tagYoutube.youtube });
  const tagResult = await tagWorker.run({ id: 'channel-id', uploads: 'uploads-id' }, {});
  assert.equal(tagResult.blocked, true);
  assert.deepEqual(tagYoutube.calls, []);

  const monetizationYoutube = countedYoutube();
  const monetization = createMonetizationWorker({
    store, youtube: monetizationYoutube.youtube,
    env: { YOUTUBE_PUBLIC_LIVE_MONETIZATION: 'true' }
  });
  const result = await monetization.run();
  assert.equal(result.quotaBlocked, true);
  assert.equal(result.quotaBlockedUntil, BLOCKED_UNTIL);
  assert.deepEqual(monetizationYoutube.calls, []);
});

test('Short view checks and Japanese localization stop before the YouTube API', async () => {
  let state = { enabled: true };
  const store = blockedStore({
    async listDrafts() { return [{ id: 'draft-1', sourceType: 'twitch_highlight_short', youtubeVideoId: 'video-1' }]; },
    async getDraft() { return null; },
    async updateDraft(_id, patch) { return patch; },
    async getJapaneseLocalizationAutopilotState() { return structuredClone(state); },
    async saveJapaneseLocalizationAutopilotState(next) { state = structuredClone(next); }
  });

  const shortYoutube = countedYoutube();
  const monitor = createShortViewMonitor({ store, youtube: shortYoutube.youtube });
  assert.equal(await monitor.refreshAll(), 0);
  assert.deepEqual(shortYoutube.calls, []);

  const localizationYoutube = countedYoutube();
  let translations = 0;
  const localization = createJapaneseLocalizationWorker({
    store, youtube: localizationYoutube.youtube,
    env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate: async () => { translations += 1; return []; }
  });
  const result = await localization.run();
  assert.equal(result.status, 'quota_wait');
  assert.equal(result.retryAfter, BLOCKED_UNTIL);
  assert.equal(translations, 0);
  assert.deepEqual(localizationYoutube.calls, []);
});

test('playlist assignment and SEO market research skip requests during a shared quota pause', async () => {
  const store = blockedStore({
    async reservePlaylistAutoSlot() { return { allowed: true }; },
    async getSeoMarketSnapshot() { return null; },
    async saveSeoMarketSnapshot() {},
    async getSeoMarketBudget() { return null; },
    async saveSeoMarketBudget() {}
  });
  const playlistYoutube = countedYoutube();
  const playlists = createPlaylistAutoAssigner({ store, youtube: playlistYoutube.youtube });
  const result = await playlists.assign({
    id: 'abcdefghijk', privacyStatus: 'public', title: 'ARC Raiders gameplay'
  });
  assert.equal(result.state, 'retry');
  assert.equal(result.quotaBlockedUntil, BLOCKED_UNTIL);
  assert.deepEqual(playlistYoutube.calls, []);

  const marketYoutube = countedYoutube();
  const market = createSeoMarket({
    store, youtube: marketYoutube.youtube, env: { SEO_MARKET_RESEARCH: 'true' }
  });
  assert.equal(await market.research({ title: 'ARC Raiders gameplay', channelId: 'other' }), null);
  assert.deepEqual(marketYoutube.calls, []);
});

test('SEO worker honors the shared quota pause before catalog reads', async () => {
  const store = blockedStore();
  let catalogReads = 0;
  const youtube = {
    async isConnected() { return true; },
    async ownedChannel() { catalogReads += 1; return { id: 'channel-id' }; }
  };
  const worker = createSeoWorker({ store, youtube, env: {}, logger: { info() {}, warn() {}, error() {} } });
  await worker.run();
  assert.equal(catalogReads, 0);
});

test('SEO worker resumes after the daily quota reset grace', async () => {
  let now = Date.parse('2026-10-23T06:59:00.000Z');
  const blockedUntil = now + 60 * 1000;
  const graceMs = 60 * 1000;
  let storedBlock = { blockedUntil, reason: 'daily quota' };
  let timer = null;
  let scheduledRun = null;
  let ownedChannelCalls = 0;
  const store = blockedStore({
    async getYoutubeDataApiQuotaBlock() { return storedBlock; },
    async saveYoutubeDataApiQuotaBlock(value) { storedBlock = value; return value; },
    async getSeoSyncState() {
      return { enabled: false, completed: true, viewPriorityScanVersion: 1,
        channelId: 'channel-id', recentAt: new Date(blockedUntil).toISOString() };
    },
    async saveSeoSyncState() {}
  });
  const youtube = {
    async isConnected() { return true; },
    async ownedChannel() { ownedChannelCalls += 1; return { id: 'channel-id', title: 'Amaana' }; }
  };
  const workerErrors = [];
  const worker = createSeoWorker({
    store, youtube, env: {}, logger: { info() {}, warn() {}, error(...args) { workerErrors.push(args); } },
    setTimeoutFn(callback, delay) {
      timer = { callback, delay, unref() {} };
      return timer;
    },
    clearTimeoutFn() {},
    setImmediateFn(callback) { scheduledRun = callback; }
  });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await worker.run();
    assert.equal(ownedChannelCalls, 0);
    assert.equal(timer?.delay, 60 * 1000 + graceMs);
    const firstTimer = timer;
    firstTimer.callback(); // Simulate an early timer delivery.
    assert.equal(ownedChannelCalls, 0);
    assert.notEqual(timer, firstTimer);
    assert.equal(timer?.delay, 60 * 1000 + graceMs);

    storedBlock = null;
    now = blockedUntil + graceMs;
    timer.callback();
    assert.equal(typeof scheduledRun, 'function');
    let completionTimer;
    try {
      await Promise.race([
        scheduledRun(),
        new Promise((_, reject) => {
          completionTimer = setTimeout(() => reject(new Error('resumed SEO pass timed out')), 5000);
        })
      ]);
    } finally {
      if (completionTimer) clearTimeout(completionTimer);
    }
    assert.equal(ownedChannelCalls, 1);
    assert.deepEqual(workerErrors, []);
  } finally {
    Date.now = realNow;
  }
});

test('a stale quota timer cannot replace a newer persisted deadline', async () => {
  let now = Date.parse('2026-10-23T06:00:00.000Z');
  let storedBlock = { blockedUntil: now + 60 * 1000, reason: 'YouTube Data API rate limit reached' };
  const timers = [];
  const cleared = [];
  const store = blockedStore({
    async getYoutubeDataApiQuotaBlock() { return storedBlock; },
    async saveYoutubeDataApiQuotaBlock(value) { storedBlock = value; return value; },
    async getSeoSyncState() { return {}; },
    async saveSeoSyncState() {}
  });
  const worker = createSeoWorker({
    store,
    youtube: { async isConnected() { return true; } },
    env: {}, logger: { info() {}, warn() {}, error() {} },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { cleared.push(timer); }
  });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await worker.run();
    const firstTimer = timers[0];
    await recordYouTubeDataApiQuotaBlock(store, now + 2 * 60 * 1000, now);
    await worker.run();
    const secondTimer = timers[1];
    assert.ok(cleared.includes(firstTimer));

    firstTimer.callback(); // A canceled callback may already be queued.
    await recordYouTubeDataApiQuotaBlock(store, now + 3 * 60 * 1000, now);
    await worker.run();

    assert.equal(timers.length, 3);
    assert.ok(cleared.includes(secondTimer));
  } finally {
    Date.now = realNow;
  }
});
