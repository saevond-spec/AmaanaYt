'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {
  createTwitchHighlightDiscovery,
  selectCommunityHighlights,
  scanIntervalForVod
} = require('../src/twitch-highlight-discovery');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function makeVod(id = '1001', overrides = {}) {
  return {
    id,
    type: 'archive',
    user_id: 'broadcaster-1',
    user_name: 'AmaanaYT',
    user_login: 'amaanayt',
    title: 'Ranked gaming session',
    duration: '2h',
    created_at: '2026-10-18T12:00:00.000Z',
    ...overrides
  };
}

function makeClip(id, offset, duration = 20, views = 1, overrides = {}) {
  return {
    id,
    video_id: '1001',
    broadcaster_id: 'broadcaster-1',
    game_id: '509658',
    vod_offset: offset,
    duration,
    view_count: views,
    title: `Moment ${id}`,
    created_at: '2026-10-18T14:00:00.000Z',
    ...overrides
  };
}

function harness({ vods = [makeVod()], clipsByVod = {}, initialDrafts = [], liveBroadcast = null, video = null,
  liveCaptureIntervalMs = 3 * MINUTE, liveCaptureDurationSeconds = 60,
  liveClips = [],
  startAt = Date.parse('2026-10-18T15:00:00.000Z'),
  now = () => startAt, getVodError, listError, clipErrorByVod = {}, onClipsRead,
  targetDurationSeconds = 15, visualGameplayVerificationAvailable = true } = {}) {
  let clock = startAt;
  let persistedState = null;
  const drafts = [...initialDrafts];
  const enqueued = [];
  const enqueuedClips = [];
  const calls = { vodList: 0, vodGet: 0, clipList: 0, stateSaves: 0,
    liveLookups: 0, liveClipCreates: [], liveCommunityClipLookups: 0 };
  const liveClipRequests = new Map();
  let liveClipNumber = 0;
  const twitch = {
    async listRecentArchivedVods(options) {
      calls.vodList += 1;
      calls.vodListOptions = options;
      if (listError) throw listError;
      return vods;
    },
    async getVod(id) {
      calls.vodGet += 1;
      if (getVodError) throw getVodError;
      return vods.find((vod) => String(vod.id) === String(id)) || makeVod(String(id));
    },
    async listClipsForVod(vod) {
      calls.clipList += 1;
      onClipsRead?.(vod);
      if (clipErrorByVod[String(vod.id)]) throw clipErrorByVod[String(vod.id)];
      return typeof clipsByVod[String(vod.id)] === 'function'
        ? clipsByVod[String(vod.id)]()
        : clipsByVod[String(vod.id)] || [];
    },
    async getLiveBroadcast() {
      calls.liveLookups += 1;
      return typeof liveBroadcast === 'function' ? liveBroadcast() : liveBroadcast;
    },
    async listRecentLiveClips() {
      calls.liveCommunityClipLookups += 1;
      return liveClips;
    },
    async createClipFromVod(request) {
      calls.liveClipCreates.push(request);
      const clip = {
        id: 'live-clip-' + (++liveClipNumber),
        broadcasterId: '1001',
        editorId: '1001'
      };
      liveClipRequests.set(clip.id, request);
      return clip;
    },
    async waitForClipDownload({ clipId }) {
      return { landscape_download_url: 'fixture://' + clipId };
    },
    async downloadClip(_url, destination) {
      await fs.writeFile(destination, 'fixture');
    },
    async getClip(clipId) {
      const request = liveClipRequests.get(clipId);
      return {
        id: clipId, video_id: String(request.vodId),
        broadcaster_id: '1001', game_id: '509658',
        vod_offset: request.vodOffset - request.duration,
        duration: request.duration, view_count: 0,
        title: 'Verified live gameplay', created_at: new Date(clock).toISOString()
      };
    }
  };
  const store = {
    async listDrafts() { return drafts.slice(); },
    async addDraft(draft) {
      if (drafts.some((existing) => existing.id === draft.id)) throw new Error('duplicate draft id');
      drafts.push(draft);
      return draft;
    },
    async getTwitchHighlightDiscoveryState() { return persistedState; },
    async saveTwitchHighlightDiscoveryState(state) {
      calls.stateSaves += 1;
      persistedState = structuredClone(state);
    }
  };
  const logger = { info() {}, warn() {}, error() {} };
  const discovery = createTwitchHighlightDiscovery({
    twitch, store, video, enqueueBatch: (id) => enqueued.push(id),
    enqueueClip: (id) => enqueuedClips.push(id), logger,
    idFactory: (() => { let id = 0; return () => `batch-${++id}`; })(), now,
    scanIntervalMs: 15 * MINUTE, targetDurationSeconds,
    liveCaptureIntervalMs, liveCaptureDurationSeconds,
    visualGameplayVerificationAvailable: () => visualGameplayVerificationAvailable
  });
  return {
    discovery, twitch, store, drafts, enqueued, enqueuedClips, calls,
    get state() { return persistedState; },
    setNow(value) { clock = value; startAt = value; },
    getNow() { return clock; }
  };
}

function formatTwitchDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return (hours ? hours + 'h' : '') + (minutes ? minutes + 'm' : '') + seconds + 's';
}

function makeLiveBroadcast(clock, streamStartedAt) {
  const elapsed = Math.floor((clock - streamStartedAt) / 1000);
  return {
    user: { id: '1001' },
    stream: {
      id: '7777', user_id: '1001', user_name: 'AmaanaYT',
      user_login: 'amaanayt', title: 'Ranked gaming session', game_id: '509658',
      game_name: 'Test Game', started_at: new Date(streamStartedAt).toISOString()
    },
    vod: {
      id: '9001', stream_id: '7777', user_id: '1001', type: 'archive',
      title: 'Ranked gaming session', created_at: new Date(streamStartedAt).toISOString(),
      duration: formatTwitchDuration(elapsed)
    }
  };
}

test('selects linked, in-range, game-category clips with exact target duration and no overlaps', () => {
  const vod = makeVod();
  const clips = [
    makeClip('top', 100, 20, 100),
    makeClip('overlap', 105, 20, 99),
    makeClip('earlier', 5, 30, 50),
    makeClip('backfill', 200, 15, 10),
    makeClip('wrong-vod', 300, 20, 10000, { video_id: '9999' }),
    makeClip('wrong-channel', 400, 20, 10000, { broadcaster_id: 'other' }),
    makeClip('unlinked', null, 20, 10000, { video_id: '' }),
    makeClip('no-offset', null, 20, 10000),
    makeClip('negative', -2, 20, 10000),
    makeClip('too-short', 500, 4.9, 10000),
    makeClip('too-long', 600, 60.1, 10000),
    makeClip('beyond-vod', 7190, 20, 10000)
  ];

  const result = selectCommunityHighlights(clips, vod, { targetDurationSeconds: 65 });
  assert.deepEqual(result.evidence.map((item) => item.clipId), ['earlier', 'top', 'backfill']);
  assert.deepEqual(result.highlights.map((item) => item.startSeconds), [5, 100, 200]);
  assert.match(result.highlights[1].reason, /Twitch game category 509658/);
  assert.equal(result.highlights[0].score > 0, true);
});

test('enforces the requested segment cap and backfills lower ranked non-overlapping clips', () => {
  const vod = makeVod();
  const clips = [
    ...Array.from({ length: 8 }, (_, index) => makeClip(`clip-${index}`, index * 100, 20, 100 - index)),
    makeClip('lower-ranked', 1000, 15, 1)
  ];
  const result = selectCommunityHighlights(clips, vod, { limit: 5, targetDurationSeconds: 100 });
  assert.equal(result.highlights.length, 5);
  assert.deepEqual(result.evidence.map((item) => item.clipId), ['clip-0', 'clip-1', 'clip-2', 'clip-6', 'clip-7']);
  assert.equal(selectCommunityHighlights(clips, vod, { limit: 100, targetDurationSeconds: 100 }).highlights.length, 5);
});

test('keeps WzBot test titles out of 15-minute gameplay selection', () => {
  const clips = [
    makeClip('ranked-gameplay', 100, 20, 1, { title: 'Ranked clutch' }),
    makeClip('wzbot-test', 200, 20, 100000, { title: 'WzBot CLIP | Test (by saevond)' })
  ];
  const result = selectCommunityHighlights(clips, makeVod(), { targetDurationSeconds: 20 });
  assert.deepEqual(result.evidence.map((item) => item.clipId), ['ranked-gameplay']);
  assert.deepEqual(result.highlights.map((item) => item.startSeconds), [100]);
});

test('returns no candidate when Twitch has not linked community clips to the VOD yet', () => {
  const result = selectCommunityHighlights([
    makeClip('live-clip', 200, 20, 500, { video_id: '', vod_offset: null })
  ], makeVod());
  assert.deepEqual(result.highlights, []);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.rejectionReason, 'no_game_category_clips');
});

test('rejects invalid archive duration rather than guessing a timestamp boundary', () => {
  assert.throws(() => selectCommunityHighlights([], makeVod('1001', { duration: 'unknown' })), /invalid VOD duration/);
});

test('holds Twitch VOD work when opt-in visual gameplay screening is disabled', async () => {
  const vod = makeVod();
  const h = harness({ vods: [vod], visualGameplayVerificationAvailable: false,
    clipsByVod: { [vod.id]: [makeClip('candidate', 300, 30, 20)] } });
  const result = await h.discovery.run();

  assert.equal(result.visualScreeningUnavailable, 1);
  assert.equal(result.queued, 0);
  assert.equal(h.calls.clipList, 0);
  assert.equal(h.drafts.length, 0);
});

test('creates one private-pipeline batch from Amaana-discovered Twitch clip evidence', async () => {
  const vod = makeVod();
  const clips = Array.from({ length: 20 }, (_, index) =>
    makeClip(`community-${index + 1}`, index * 120, 45, 100 - index));
  const h = harness({ vods: [vod], targetDurationSeconds: 900,
    clipsByVod: { [vod.id]: clips } });
  const result = await h.discovery.run();
  assert.equal(result.queued, 1);
  assert.equal(result.scanned, 1);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].discoverySource, 'twitch_clips_api');
  assert.equal(h.drafts[0].sourceType, 'twitch_highlight_batch');
  assert.equal(h.drafts[0].sourceChannel, 'AmaanaYT');
  assert.equal(h.drafts[0].sourceClipEvidence.length, 20);
  assert.equal(h.drafts[0].targetHighlightDurationSeconds, 900);
  assert.equal(h.drafts[0].highlights.reduce((sum, item) => sum + item.duration, 0), 900);
  assert.equal(h.drafts[0].shortCandidateIndexes.length, 2);
  assert.deepEqual(h.enqueued, ['batch-1']);
  assert.equal(h.calls.vodListOptions.first, 20);
});

test('does not queue a 15-minute batch when the robust quality floor leaves only weak footage', async () => {
  const vod = makeVod();
  const highStarts = [1350, 1350, 1440, 1440, 1530, 1530, 1620, 1710, 1800, 1890, 1980, 2070, 2160, 2250, 2340];
  const clips = [
    ...Array.from({ length: 15 }, (_, index) => makeClip('low-' + index, index * 90, 60, 0)),
    ...highStarts.map((start, index) => makeClip('high-' + index, start, 60, 10000))
  ];
  const h = harness({ vods: [vod], targetDurationSeconds: 900,
    clipsByVod: { [vod.id]: clips } });

  const result = await h.discovery.scanVod(vod);

  assert.equal(result.status, 'insufficient_quality_gameplay');
  assert.equal(result.availableGameplaySeconds, 720);
  assert.ok(result.unfilteredGameplaySeconds >= 900);
  assert.equal(result.qualityCalibration.method, 'per_vod_median_mad_capped_at_p90');
  assert.equal(h.drafts.length, 0);
  assert.deepEqual(h.enqueued, []);
});

test('skips a live broadcast titled Test before community clip intake or capture', async () => {
  const clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  const broadcast = makeLiveBroadcast(clock, streamStartedAt);
  broadcast.stream.title = 'Test';
  broadcast.vod.title = 'Test';
  const video = {
    async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
    async verifyGameplay() {
      return { verified: true, totalFrames: 5, activeGameplayFrames: 5, confidence: 0.95 };
    }
  };
  const h = harness({ liveBroadcast: broadcast, video, startAt: clock, liveClips: [
    makeClip('should-not-queue', 360, 30, 100, { broadcaster_id: '1001' })
  ] });

  const result = await h.discovery.runLive();

  assert.equal(result.status, 'test_stream_skipped');
  assert.equal(result.captureAttempted, false);
  assert.equal(h.calls.liveCommunityClipLookups, 0);
  assert.equal(h.calls.liveClipCreates.length, 0);
  assert.equal(h.drafts.length, 0);
  assert.deepEqual(h.enqueuedClips, []);
});

test('captures and screens live segments, then queues the 15-minute review batch before stream end', async () => {
  let clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  const video = {
    async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
    async verifyGameplay() {
      return { verified: true, totalFrames: 5, activeGameplayFrames: 5,
        confidence: 0.95, gameName: 'Test Game', model: 'fixture' };
    }
  };
  const h = harness({
    liveBroadcast: () => makeLiveBroadcast(clock, streamStartedAt),
    video, startAt: clock, now: () => clock, targetDurationSeconds: 900
  });

  const first = await h.discovery.runLive();
  assert.equal(first.captureAccepted, true);
  assert.equal(first.batchesQueued, 0);
  assert.equal(h.state.liveSessions['7777'].candidates.length, 1);

  let finalResult = first;
  for (let index = 1; index < 15; index += 1) {
    clock += 3 * MINUTE;
    h.setNow(clock);
    finalResult = await h.discovery.runLive();
  }
  assert.equal(finalResult.captureAccepted, true);
  assert.equal(finalResult.batchesQueued, 1);
  assert.equal(h.drafts.length, 4);
  const batch = h.drafts.find((draft) =>
    draft.sourceType === 'twitch_highlight_batch' && draft.discoverySource === 'twitch_live_capture');
  const liveShorts = h.drafts.filter((draft) =>
    draft.sourceType === 'twitch_vod' && draft.discoverySource === 'twitch_live_capture');
  assert.equal(batch.discoverySource, 'twitch_live_capture');
  assert.equal(batch.streamId, '7777');
  assert.equal(batch.targetHighlightDurationSeconds, 900);
  assert.equal(batch.highlights.reduce((sum, item) => sum + item.duration, 0), 900);
  assert.equal(batch.twitchClips.length, 15);
  assert.deepEqual(batch.shortCandidateIndexes, []);
  assert.ok(batch.twitchClips.every((clip) =>
    clip.liveCapture === true && clip.requestProofVersion === 1 &&
    clip.requestedVodId === '9001'));
  assert.deepEqual(h.enqueued, [batch.id]);
  assert.equal(liveShorts.length, 3);
  assert.equal(h.enqueuedClips.length, 3);
  assert.ok(liveShorts.every((draft) =>
    draft.status === 'clip_queued' && draft.liveCapture === true &&
    draft.visualGameplayVerification.verified === true));
  assert.equal(h.calls.liveClipCreates.length, 15);
  assert.ok(h.calls.liveClipCreates.every((request, index, requests) =>
    index === 0 || request.vodOffset - requests[index - 1].vodOffset === 180));

  await h.discovery.runLive();
  assert.equal(h.calls.liveClipCreates.length, 15);
  assert.equal(h.drafts.length, 4);
});

test('queues a WizeBot-style clip during a live stream before Twitch links its VOD offset', async () => {
  const clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  const broadcast = makeLiveBroadcast(clock, streamStartedAt);
  broadcast.vod = null;
  const h = harness({
    liveBroadcast: broadcast,
    liveClips: [makeClip('LuckyTallPhoneRitzMitz-FmiVE7c8LdMuQo6o', null, 30, 0, {
      broadcaster_id: '1001', video_id: '', vod_offset: null,
      created_at: new Date(clock - MINUTE).toISOString(), title: 'Ranked clutch'
    })],
    startAt: clock,
    now: () => clock,
    video: { async verifyGameplay() {}, async inspectMedia() {} }
  });

  const result = await h.discovery.runLive();
  assert.equal(result.live, true);
  assert.equal(result.communityClipsChecked, 1);
  assert.equal(result.communityClipsQueued, 1);
  assert.equal(result.status, 'active_vod_not_ready');
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].discoverySource, 'twitch_community_clip');
  assert.equal(h.drafts[0].twitchClipId, 'LuckyTallPhoneRitzMitz-FmiVE7c8LdMuQo6o');
  assert.equal(h.drafts[0].vodId, null);
  assert.deepEqual(h.enqueuedClips, [h.drafts[0].id]);

  await h.discovery.runLive();
  assert.equal(h.drafts.length, 1);
  assert.equal(h.enqueuedClips.length, 1);
});

test('does not keep or queue a live Twitch clip that fails visual gameplay review', async () => {
  let clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  const h = harness({
    liveBroadcast: () => makeLiveBroadcast(clock, streamStartedAt),
    video: {
      async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
      async verifyGameplay() {
        return { verified: false, totalFrames: 5, activeGameplayFrames: 1,
          confidence: 0.4, gameName: 'Test Game', model: 'fixture' };
      }
    },
    startAt: clock, now: () => clock, targetDurationSeconds: 60
  });

  const result = await h.discovery.runLive();
  assert.equal(result.gameplayRejected, 1);
  assert.equal(h.state.liveSessions['7777'].candidates.length, 0);
  assert.equal(h.drafts.length, 0);
  assert.deepEqual(h.enqueued, []);
  assert.deepEqual(h.enqueuedClips, []);
});

test('rejects live gameplay results above the valid frame or confidence ceiling', async () => {
  const clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  const h = harness({
    liveBroadcast: () => makeLiveBroadcast(clock, streamStartedAt),
    video: {
      async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
      async verifyGameplay() {
        return { verified: true, totalFrames: 5, activeGameplayFrames: 6,
          confidence: 1.01, gameName: 'Test Game', model: 'fixture' };
      }
    },
    startAt: clock, now: () => clock, targetDurationSeconds: 60
  });

  const result = await h.discovery.runLive();
  assert.equal(result.gameplayRejected, 1);
  assert.equal(h.state.liveSessions['7777'].candidates.length, 0);
  assert.equal(h.drafts.length, 0);
  assert.deepEqual(h.enqueuedClips, []);
});

test('flushes leftover verified live captures into a private Short draft when the stream ends', async () => {
  let clock = Date.parse('2026-10-18T15:00:00.000Z');
  const streamStartedAt = clock - 60 * MINUTE;
  let isLive = true;
  const h = harness({
    liveBroadcast: () => isLive ? makeLiveBroadcast(clock, streamStartedAt) : null,
    video: {
      async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
      async verifyGameplay() {
        return { verified: true, totalFrames: 5, activeGameplayFrames: 5,
          confidence: 0.95, gameName: 'Test Game', model: 'fixture' };
      }
    },
    startAt: clock, now: () => clock, targetDurationSeconds: 900
  });
  await h.discovery.runLive();
  clock += 3 * MINUTE;
  h.setNow(clock);
  await h.discovery.runLive();
  assert.equal(h.drafts.length, 0);

  const restarted = createTwitchHighlightDiscovery({
    twitch: h.twitch,
    store: h.store,
    video: {
      async inspectMedia() { return { durationSeconds: 60, width: 1280, height: 720 }; },
      async verifyGameplay() {
        return { verified: true, totalFrames: 5, activeGameplayFrames: 5,
          confidence: 0.95, gameName: 'Test Game', model: 'fixture' };
      }
    },
    enqueueBatch: (id) => h.enqueued.push(id),
    enqueueClip: (id) => h.enqueuedClips.push(id),
    logger: { info() {}, error() {} },
    now: () => clock,
    targetDurationSeconds: 900,
    visualGameplayVerificationAvailable: () => true
  });
  isLive = false;
  const result = await restarted.runLive();

  assert.equal(result.status, 'not_live');
  assert.equal(result.liveShortsQueued, 1);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].sourceType, 'twitch_vod');
  assert.equal(h.drafts[0].liveCapture, true);
  assert.deepEqual(h.enqueuedClips, [h.drafts[0].id]);
});

test('does not create Twitch clips for a live stream when visual gameplay screening is disabled', async () => {
  const h = harness({ liveBroadcast: makeLiveBroadcast(Date.now(), Date.now() - 60 * MINUTE),
    visualGameplayVerificationAvailable: false });
  const result = await h.discovery.runLive();

  assert.equal(result.status, 'visual_gameplay_screening_disabled');
  assert.equal(h.calls.liveLookups, 0);
  assert.equal(h.calls.liveClipCreates.length, 0);
});

test('ignores active streams and non-archive entries even if a provider returns them', async () => {
  const archive = makeVod();
  const live = makeVod('1002', { type: 'live' });
  const h = harness({ vods: [live, archive], clipsByVod: { [archive.id]: [makeClip('one', 10, 15, 1)] } });
  const result = await h.discovery.run();
  assert.equal(result.scanned, 1);
  assert.equal(h.calls.clipList, 1);
  assert.equal(h.drafts[0].vodId, archive.id);
});

test('saves an empty scan and retries after Twitch’s delayed VOD offset becomes available', async () => {
  const vod = makeVod();
  const clips = [];
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: () => clips } });
  const first = await h.discovery.run();
  assert.equal(first.noCandidates, 1);
  assert.equal(h.drafts.length, 0);
  assert.equal(h.state.lastScannedAt[vod.id], new Date(h.getNow()).toISOString());

  h.setNow(h.getNow() + 14 * MINUTE);
  const throttled = await h.discovery.run();
  assert.equal(throttled.throttled, 1);
  assert.equal(h.calls.clipList, 1);

  clips.push(makeClip('late-linked-clip', 123, 20, 6));
  h.setNow(h.getNow() + 1 * MINUTE);
  const retried = await h.discovery.run();
  assert.equal(retried.queued, 1);
  assert.equal(h.drafts[0].sourceClipEvidence[0].clipId, 'late-linked-clip');
});

test('restores scan throttles from persistent storage after a worker restart', async () => {
  const vod = makeVod();
  const h = harness({ vods: [vod] });
  await h.discovery.run();
  h.setNow(h.getNow() + 5 * MINUTE);
  const restarted = createTwitchHighlightDiscovery({
    twitch: h.twitch,
    store: h.store,
    enqueueBatch: (id) => h.enqueued.push(id),
    logger: { info() {}, error() {} },
    now: h.getNow,
    scanIntervalMs: 15 * MINUTE,
    targetDurationSeconds: 15
  });
  const result = await restarted.run();
  assert.equal(result.throttled, 1);
  assert.equal(h.calls.clipList, 1);
});

test('does not duplicate a batch already created for the VOD', async () => {
  const vod = makeVod();
  const existing = { id: 'existing', sourceType: 'twitch_highlight_batch', vodId: vod.id, targetHighlightDurationSeconds: 15 };
  const h = harness({ vods: [vod], initialDrafts: [existing] });
  const result = await h.discovery.run();
  assert.equal(result.alreadyExists, 1);
  assert.equal(h.calls.clipList, 0);
  assert.deepEqual(h.enqueued, []);
});

test('legacy short Twitch drafts do not block a replacement that supersedes them', async () => {
  const vod = makeVod();
  const legacy = { id: 'legacy', sourceType: 'twitch_highlight_batch', vodId: vod.id,
    duration: 119.6, status: 'awaiting_owner_approval' };
  const clips = [makeClip('replacement-clip', 300, 15, 30)];
  const h = harness({ vods: [vod], initialDrafts: [legacy], clipsByVod: { [vod.id]: clips } });
  const result = await h.discovery.run();

  assert.equal(result.queued, 1);
  assert.equal(h.drafts.length, 2);
  assert.equal(h.drafts[0], legacy);
  assert.equal(h.drafts[1].targetHighlightDurationSeconds, 15);
  assert.equal(h.drafts[1].supersedesDraftId, 'legacy');
  assert.equal(h.enqueued.length, 1);
});

test('continues scanning other VODs after one Twitch request fails', async () => {
  const first = makeVod('1001');
  const second = makeVod('1002');
  const h = harness({
    vods: [first, second],
    clipsByVod: { [second.id]: [makeClip('second-clip', 50, 15, 2, { video_id: second.id })] },
    clipErrorByVod: { [first.id]: new Error('temporary Twitch API issue') }
  });
  const result = await h.discovery.run();
  assert.equal(result.errors, 1);
  assert.equal(result.queued, 1);
  assert.equal(h.drafts[0].vodId, second.id);
  assert.equal(h.state.lastScannedAt[first.id], undefined);
});

test('manual and scheduled archive discovery skip a placeholder Test VOD before reading clips', async () => {
  const vod = makeVod('1001', { user_id: '1001', title: 'Test' });
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: [makeClip('not-gameplay', 360, 30, 100)] } });

  const manual = await h.discovery.scanVod(vod);
  assert.equal(manual.status, 'test_stream_skipped');
  assert.equal(h.calls.clipList, 0);
  assert.equal(h.drafts.length, 0);
  assert.deepEqual(h.enqueued, []);
  assert.deepEqual(h.enqueuedClips, []);

  const scheduledHarness = harness({ vods: [vod] });
  const scheduled = await scheduledHarness.discovery.run();
  assert.equal(scheduled.testStreamsSkipped, 1);
  assert.equal(scheduledHarness.calls.clipList, 0);
  assert.equal(scheduledHarness.drafts.length, 0);
});

test('manual VOD scans resolve the ID through Amaana’s own broadcaster authorization', async () => {
  const vod = makeVod('1001', { user_id: '1001' });
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: [makeClip('manual-clip', 360, 30, 8,
    { broadcaster_id: '1001' })] } });
  const result = await h.discovery.scanVod(vod.id);
  assert.equal(result.status, 'queued');
  assert.equal(result.communityClipsQueued, 1);
  assert.equal(h.calls.vodGet, 1);
  assert.equal(h.calls.clipList, 1);
  const batch = h.drafts.find((draft) => draft.sourceType === 'twitch_highlight_batch');
  assert.equal(batch.sourceClipEvidence[0].clipId, 'manual-clip');
});

test('manual VOD scan queues clip screening even when footage is too short for the full highlight', async () => {
  const vod = makeVod('1001', { user_id: '1001' });
  const h = harness({
    vods: [vod],
    clipsByVod: { [vod.id]: [makeClip('short-manual-clip', 360, 30, 8,
      { broadcaster_id: '1001' })] },
    targetDurationSeconds: 15 * 60
  });
  const result = await h.discovery.scanVod(vod.id);
  assert.equal(result.status, 'insufficient_gameplay_duration');
  assert.equal(result.communityClipsQueued, 1);
  assert.equal(result.batch, undefined);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].discoverySource, 'twitch_community_clip');
  assert.deepEqual(h.enqueuedClips, [h.drafts[0].id]);
});

test('manual scan fails closed when the authorized VOD lookup fails', async () => {
  const h = harness({ getVodError: Object.assign(new Error('not the connected broadcaster'), { status: 403 }) });
  await assert.rejects(h.discovery.scanVod('1001'), /not the connected broadcaster/);
  assert.equal(h.calls.clipList, 0);
  assert.equal(h.drafts.length, 0);
});

test('simultaneous scans for one VOD share a single Twitch clip lookup', async () => {
  const vod = makeVod();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ vods: [vod], clipsByVod: { [vod.id]: async () => {
    started();
    await gate;
    return [makeClip('concurrent-clip', 600, 25, 3)];
  } } });
  const first = h.discovery.scanVod(vod);
  await startedPromise;
  const second = await h.discovery.scanVod(vod);
  assert.equal(second.status, 'already_scanning');
  release();
  assert.equal((await first).status, 'queued');
  assert.equal(h.calls.clipList, 1);
  assert.equal(h.drafts.length, 1);
});

test('overlapping scheduled runs do not start a second VOD inventory request', async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const vod = makeVod();
  const h = harness({ vods: [vod] });
  const original = h.twitch.listRecentArchivedVods;
  h.twitch.listRecentArchivedVods = async (...args) => {
    started();
    await gate;
    return original(...args);
  };
  const first = h.discovery.run();
  await startedPromise;
  assert.deepEqual(await h.discovery.run(), { skipped: 'already_running' });
  release();
  await first;
  assert.equal(h.calls.vodList, 1);
});

test('scanner records a broken Twitch inventory without throwing out of the timer callback', async () => {
  const h = harness({ listError: new Error('Twitch unavailable') });
  const result = await h.discovery.run();
  assert.equal(result.errors, 0);
  assert.equal(h.discovery.status().lastRunError, 'Twitch unavailable');
  assert.ok(h.discovery.status().lastRunAt);
});

test('does not call Twitch Helix while the Amaana Twitch connection is disconnected', async () => {
  const h = harness();
  h.twitch.isConnected = async () => false;
  const result = await h.discovery.run();
  assert.equal(result.notConnected, true);
  assert.equal(h.calls.vodList, 0);
  assert.equal(h.calls.clipList, 0);
});

test('five-year daily rescan projection stays bounded for old VODs', async () => {
  const vod = makeVod('1001', { created_at: '2019-12-20T00:00:00.000Z' });
  const startAt = Date.parse('2020-01-01T00:00:00.000Z');
  const h = harness({ vods: [vod], startAt });
  const numberOfDays = 365 * 5 + 1;
  for (let day = 0; day < numberOfDays; day += 1) {
    h.setNow(startAt + day * DAY);
    await h.discovery.run();
  }
  assert.equal(h.calls.clipList, numberOfDays);
  assert.equal(h.drafts.length, 0);
  assert.equal(scanIntervalForVod(vod, startAt + numberOfDays * DAY), DAY);
});

