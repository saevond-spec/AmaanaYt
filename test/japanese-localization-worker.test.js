'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJapaneseLocalizationWorker } = require('../src/japanese-localization-worker');

const FIXED_NOW = Date.parse('2026-10-19T12:00:00.000Z');
const CHANNEL_ID = 'UCchannel123456';

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    async getJapaneseLocalizationAutopilotState() { return structuredClone(state); },
    async saveJapaneseLocalizationAutopilotState(next) { state = structuredClone(next); },
    read() { return structuredClone(state); }
  };
}

function japaneseResult(entry) {
  return {
    id: entry.id,
    title: ('日本語 ' + (entry.title || 'タイトル')).slice(0, entry.titleLimit || 100),
    description: '日本語の説明です。'
  };
}

function connectedYouTube({ channel, videos = [], playlists = [] } = {}) {
  const updates = [];
  const youtube = {
    async isConnected() { return true; },
    async channelSeo() { return structuredClone(channel); },
    async updateJapaneseChannelLocalization(expected, value) {
      updates.push({ kind: 'channel', expected, value });
    },
    async ownedVideosCursorPage(token) {
      return { channelId: CHANNEL_ID, items: structuredClone(token ? [] : videos), nextPageToken: null };
    },
    async updateJapaneseVideoLocalization(expected, value) {
      updates.push({ kind: 'video', expected, value });
    },
    async listOwnedPlaylists() { return structuredClone(playlists); },
    async updateJapanesePlaylistLocalization(expected, value) {
      updates.push({ kind: 'playlist', expected, value });
    }
  };
  return { youtube, updates };
}

const translate = async (entries) => entries.map(japaneseResult);

test('autopilot directly saves missing profile, video, and playlist translations and keeps existing Japanese entries', async () => {
  const store = memoryStore({ enabled: true });
  const { youtube, updates } = connectedYouTube({
    channel: { id: CHANNEL_ID, etag: 'channel-etag', title: 'Saevond', description: 'Gaming channel', localizations: {} },
    videos: [
      { id: 'aaaaaaaaaaa', etag: 'video-a', snippet: { channelId: CHANNEL_ID, title: 'Video A', description: 'Gameplay' }, localizations: {} },
      { id: 'bbbbbbbbbbb', etag: 'video-b', snippet: { channelId: CHANNEL_ID, title: 'Video B', description: 'Highlights' }, localizations: {} },
      { id: 'ccccccccccc', etag: 'video-c', snippet: { channelId: CHANNEL_ID, title: 'Video C', description: 'Already translated' }, localizations: { ja: { title: '既存', description: '既存の説明' } } }
    ],
    playlists: [
      { id: 'PL-one', etag: 'playlist-a', title: 'Gameplay', description: 'Recent matches', localizations: {} },
      { id: 'PL-two', etag: 'playlist-b', title: 'Existing', description: 'Keep this', localizations: { ja: { title: '保存済み', description: '変更しない' } } }
    ]
  });
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate, now: () => FIXED_NOW, logger: { error() {} }
  });

  const result = await worker.run();

  assert.equal(result.status, 'monitoring');
  assert.deepEqual(result.lastRun, { channel: 1, videos: 2, playlists: 1, conflicts: 0 });
  assert.equal(result.updatesToday, 4);
  assert.deepEqual(updates.map((update) => update.kind), ['channel', 'video', 'video', 'playlist']);
  assert.equal(updates[0].expected.etag, 'channel-etag');
  assert.equal(updates[0].value.title.startsWith('日本語'), true);
  assert.equal(store.read().enabled, true);
});

test('autopilot pauses at the daily update cap before calling YouTube or the translator', async () => {
  const store = memoryStore({ enabled: true, quotaDate: '2026-10-19', updatesToday: 100 });
  let youtubeCalls = 0;
  let translationCalls = 0;
  const youtube = { async channelSeo() { youtubeCalls += 1; } };
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate: async () => { translationCalls += 1; return []; },
    now: () => FIXED_NOW, logger: { error() {} }
  });

  const result = await worker.run();

  assert.equal(result.status, 'quota_wait');
  assert.equal(result.updatesToday, 100);
  assert.equal(youtubeCalls, 0);
  assert.equal(translationCalls, 0);
});

test('autopilot rechecks a partially processed video page on the next run and advances only after it is complete', async () => {
  const first = { id: 'aaaaaaaaaaa', etag: 'video-a', snippet: { channelId: CHANNEL_ID, title: 'Video A', description: '' }, localizations: {} };
  const second = { id: 'bbbbbbbbbbb', etag: 'video-b', snippet: { channelId: CHANNEL_ID, title: 'Video B', description: '' }, localizations: {} };
  const store = memoryStore({ enabled: true, quotaDate: '2026-10-19', updatesToday: 0 });
  const { youtube, updates } = connectedYouTube({
    channel: { id: CHANNEL_ID, etag: 'channel-etag', title: 'Saevond', description: 'Profile', localizations: { ja: { title: 'Saevond', description: 'プロフィール' } } },
    videos: [first, second]
  });
  youtube.ownedVideosCursorPage = async (token) => ({
    channelId: CHANNEL_ID,
    items: token ? [] : [structuredClone(first), structuredClone(second)],
    nextPageToken: token ? null : 'page-two'
  });
  youtube.updateJapaneseVideoLocalization = async (expected, value) => {
    updates.push({ kind: 'video', expected, value });
    if (expected.id === first.id) first.localizations.ja = value;
    if (expected.id === second.id) second.localizations.ja = value;
  };
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate, runUpdateLimit: 1, now: () => FIXED_NOW, logger: { error() {} }
  });

  const firstRun = await worker.run();
  assert.equal(firstRun.updatesToday, 1);
  assert.equal(firstRun.videoPageToken, null);
  assert.equal(updates.length, 1);

  const secondRun = await worker.run();
  assert.equal(secondRun.updatesToday, 2);
  assert.equal(secondRun.videoPageToken, 'page-two');
  assert.equal(updates.length, 2);
  assert.equal(updates[1].expected.id, second.id);
});

test('autopilot records provider failure and honors its retry backoff', async () => {
  const store = memoryStore({ enabled: true });
  let calls = 0;
  const { youtube } = connectedYouTube({
    channel: { id: CHANNEL_ID, etag: 'channel-etag', title: 'Saevond', description: 'Profile', localizations: {} }
  });
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate: async () => { calls += 1; throw new Error('provider unavailable'); },
    now: () => FIXED_NOW, logger: { error() {} }
  });

  const failed = await worker.run();
  const retried = await worker.run();

  assert.equal(failed.status, 'error');
  assert.equal(failed.lastError, 'provider unavailable');
  assert.equal(Date.parse(failed.retryAfter), FIXED_NOW + 60 * 60 * 1000);
  assert.equal(retried.status, 'error');
  assert.equal(calls, 1);
});

test('autopilot honors a provider 429 retry hint and grows fallback delays after repeated failures', async () => {
  let currentTime = FIXED_NOW;
  const store = memoryStore({ enabled: true });
  let calls = 0;
  const { youtube } = connectedYouTube({
    channel: { id: CHANNEL_ID, etag: 'channel-etag', title: 'Saevond', description: 'Profile', localizations: {} }
  });
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate: async () => {
      calls += 1;
      const error = new Error('provider quota limited');
      error.status = 429;
      error.retryAfterPresent = calls === 1;
      error.retryAfterMs = 30_000;
      throw error;
    },
    now: () => currentTime, logger: { error() {} }
  });

  const first = await worker.run();
  assert.equal(Date.parse(first.retryAfter), FIXED_NOW + 30_000);
  await worker.run();
  assert.equal(calls, 1);

  currentTime += 30_001;
  const second = await worker.run();
  assert.equal(Date.parse(second.retryAfter), currentTime + 2 * 60 * 60 * 1000);
  assert.equal(second.retryAttempts, 2);
  assert.equal(calls, 2);

  currentTime += 2 * 60 * 60 * 1000 + 1;
  const third = await worker.run();
  assert.equal(Date.parse(third.retryAfter), currentTime + 4 * 60 * 60 * 1000);
  assert.equal(third.retryAttempts, 3);
  assert.equal(calls, 3);
});

test('autopilot resets an expired YouTube page token and restarts the video scan', async () => {
  const store = memoryStore({
    enabled: true, videoPageToken: 'expired-page-token',
    quotaDate: '2026-10-19', updatesToday: 0
  });
  const { youtube } = connectedYouTube({
    channel: { id: CHANNEL_ID, etag: 'channel-etag', title: 'Saevond', description: 'Profile',
      localizations: { ja: { title: 'Saevond', description: 'プロフィール' } } }
  });
  const pageTokens = [];
  youtube.ownedVideosCursorPage = async (token) => {
    pageTokens.push(token);
    if (token) {
      const error = new Error('page token expired');
      error.status = 400;
      throw error;
    }
    return { channelId: CHANNEL_ID, items: [], nextPageToken: null };
  };
  const worker = createJapaneseLocalizationWorker({
    store, youtube, env: { SEO_AI_API_KEY: 'configured', SEO_AI_MODEL: 'test-model' },
    translate, now: () => FIXED_NOW, logger: { error() {} }
  });

  const result = await worker.run();

  assert.deepEqual(pageTokens, ['expired-page-token', null]);
  assert.equal(result.status, 'monitoring');
  assert.equal(result.videoPageToken, null);
});

