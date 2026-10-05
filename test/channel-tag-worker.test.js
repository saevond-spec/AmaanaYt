'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChannelTagWorker } = require('../src/channel-tag-worker');
const { ensureCreatorTag } = require('../src/channel-tags');

const channel = { id: 'channel-1', uploads: 'uploads-1' };

function makeVideo(id, privacyStatus, tags = ['ARC Raiders']) {
  return {
    id, etag: 'etag-' + id,
    snippet: {
      channelId: channel.id, title: 'Existing ' + id, description: 'Keep this description.',
      categoryId: '20', tags
    },
    status: { privacyStatus }
  };
}

function harness({ videos, pages, broadcasts = [], env = {}, currentTime } = {}) {
  const byId = new Map((videos || []).map((video) => [video.id, video]));
  const updates = [];
  const saved = [];
  const youtube = {
    assertTargetChannel: async (id) => { assert.equal(id, channel.id); },
    listOwnedBroadcasts: async () => broadcasts,
    uploadsPage: async (_uploads, cursor) => {
      const page = pages.find((item) => item.cursor === (cursor || null));
      if (!page) return { ids: [], nextPageToken: null };
      return { ids: page.ids, nextPageToken: page.nextPageToken || null };
    },
    videoMetadata: async (ids) => ids.map((id) => byId.get(id)).filter(Boolean),
    updateVideoTags: async (video, channelId) => {
      assert.equal(channelId, channel.id);
      updates.push({ id: video.id, privacyStatus: video.status.privacyStatus });
      video.snippet.tags = ensureCreatorTag(video.snippet.tags, { trimOverflow: true });
      return { state: 'updated', tags: video.snippet.tags };
    }
  };
  const store = { saveSeoSyncState: async (state) => saved.push(structuredClone(state)) };
  const worker = createChannelTagWorker({
    store, youtube, env,
    now: () => currentTime?.value || Date.parse('2026-10-05T12:00:00.000Z'),
    logger: { info() {}, warn() {} }
  });
  return { worker, updates, saved, byId, currentTime };
}

test('tags the uploads catalog across privacy states and active livestreams without visibility writes', async () => {
  const publicVideo = makeVideo('publicvid01', 'public');
  const privateVideo = makeVideo('privatevid1', 'private');
  const unlistedVideo = makeVideo('unlistedvid', 'unlisted');
  const liveVideo = makeVideo('livevideo01', 'private');
  const activeBroadcast = {
    id: liveVideo.id,
    snippet: { channelId: channel.id },
    status: { privacyStatus: 'private', lifeCycleStatus: 'live' }
  };
  const state = {};
  const h = harness({
    videos: [publicVideo, privateVideo, unlistedVideo, liveVideo],
    pages: [{ cursor: null, ids: [publicVideo.id, privateVideo.id, unlistedVideo.id] }],
    broadcasts: [activeBroadcast]
  });

  const result = await h.worker.run(channel, state);
  assert.equal(result.complete, true);
  assert.deepEqual(h.updates.map((item) => item.id).sort(),
    [publicVideo.id, privateVideo.id, unlistedVideo.id, liveVideo.id].sort());
  assert.deepEqual(new Set(h.updates.map((item) => item.privacyStatus)),
    new Set(['public', 'private', 'unlisted']));
  for (const video of [publicVideo, privateVideo, unlistedVideo, liveVideo]) {
    assert.ok(video.snippet.tags.includes('@saevond'));
    assert.ok(['public', 'private', 'unlisted'].includes(video.status.privacyStatus));
  }
  assert.equal(state.creatorTagSync.tagged, 4);
  assert.equal(state.creatorTagSync.complete, true);
});

test('persists the current page and resumes at the next Pacific quota day', async () => {
  const first = makeVideo('publicvid01', 'public');
  const second = makeVideo('privatevid1', 'private');
  const currentTime = { value: Date.parse('2026-10-05T12:00:00.000Z') };
  const h = harness({
    videos: [first, second],
    pages: [{ cursor: null, ids: [first.id, second.id] }],
    env: { YOUTUBE_HANDLE_TAG_DAILY_LIMIT: '1', YOUTUBE_HANDLE_TAG_RUN_LIMIT: '1' },
    currentTime
  });
  const state = {};

  let result = await h.worker.run(channel, state);
  assert.equal(result.complete, false);
  assert.deepEqual(h.updates.map((item) => item.id), [first.id]);
  assert.deepEqual(state.creatorTagSync.pendingIds, [second.id]);

  result = await h.worker.run(channel, state);
  assert.equal(h.updates.length, 1);
  assert.equal(state.creatorTagSync.writesToday, 1);

  currentTime.value += 24 * 60 * 60 * 1000;
  result = await h.worker.run(channel, state);
  assert.equal(result.complete, true);
  assert.deepEqual(h.updates.map((item) => item.id), [first.id, second.id]);
  assert.ok(second.snippet.tags.includes('@saevond'));
});

test('scans active broadcast metadata beyond the first 50 video batch', async () => {
  const videos = Array.from({ length: 51 }, (_, index) => {
    const id = 'live' + String(index).padStart(7, '0');
    return makeVideo(id, 'private', index < 50 ? ['@saevond'] : ['ARC Raiders']);
  });
  const broadcasts = videos.map((video) => ({
    id: video.id,
    snippet: { channelId: channel.id },
    status: { privacyStatus: video.status.privacyStatus, lifeCycleStatus: 'live' }
  }));
  const h = harness({ videos, pages: [{ cursor: null, ids: [] }], broadcasts });
  const result = await h.worker.run(channel, {});

  assert.equal(result.tagged, 1);
  assert.deepEqual(h.updates.map((item) => item.id), [videos[50].id]);
  assert.ok(videos[50].snippet.tags.includes('@saevond'));
});
