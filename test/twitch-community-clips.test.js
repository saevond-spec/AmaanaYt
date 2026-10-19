'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCommunityClipDrafts,
  clipRetryDelayMs,
  isRetryableCommunityClipError,
  reuseOrVerifyGameplay
} = require('../src/twitch-community-clips');
const { isNonGameplayTestClip } = require('../src/gameplay-intake-guard');

const STREAM_START = Date.parse('2026-10-19T10:00:00.000Z');
const NOW = STREAM_START + 60 * 60 * 1000;

function clip(id, overrides = {}) {
  return {
    id,
    broadcaster_id: '1001',
    game_id: '509658',
    game_name: 'NARAKA: BLADEPOINT',
    video_id: '',
    vod_offset: null,
    duration: 30,
    view_count: 0,
    title: 'Ranked gameplay moment',
    created_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
    ...overrides
  };
}

const context = (overrides = {}) => ({
  broadcasterId: '1001', streamId: '7777', editorId: '1001',
  streamStartedAt: new Date(STREAM_START).toISOString(),
  streamTitle: 'Ranked session', sourceChannel: 'AmaanaYT',
  gameId: '509658', gameName: 'NARAKA: BLADEPOINT', vodId: null,
  existingDrafts: [], now: NOW,
  idFactory: (() => { let sequence = 0; return () => `draft-${++sequence}`; })(),
  ...overrides
});

test('imports a real WizeBot-style live clip before Twitch links it to the archive VOD', () => {
  const [draft] = buildCommunityClipDrafts([
    clip('LuckyTallPhoneRitzMitz-FmiVE7c8LdMuQo6o', { title: 'Ranked clutch' })
  ], context());

  assert.ok(draft);
  assert.equal(draft.sourceType, 'twitch_vod');
  assert.equal(draft.discoverySource, 'twitch_community_clip');
  assert.equal(draft.twitchClipId, 'LuckyTallPhoneRitzMitz-FmiVE7c8LdMuQo6o');
  assert.equal(draft.twitchBroadcasterId, '1001');
  assert.equal(draft.twitchEditorId, '1001');
  assert.equal(draft.vodId, null);
  assert.equal(draft.twitchUrl,
    'https://clips.twitch.tv/LuckyTallPhoneRitzMitz-FmiVE7c8LdMuQo6o');
  assert.match(draft.title, /Ranked clutch/);
  assert.match(draft.title, /#Shorts$/);
  assert.equal(draft.status, 'clip_queued');
  assert.equal(draft.duration, 30);
});

test('rejects explicit test stream titles, placeholder clip titles, and WzBot test commands', () => {
  assert.equal(isNonGameplayTestClip({ streamTitle: 'Test', clipTitle: 'Ranked clutch' }), true);
  assert.equal(isNonGameplayTestClip({ streamTitle: 'Ranked session', clipTitle: 'Test' }), true);
  assert.equal(isNonGameplayTestClip({
    streamTitle: 'Ranked session',
    clipTitle: 'WzBot CLIP | Test (by saevond) | Test | at 18:39'
  }), true);
  assert.equal(isNonGameplayTestClip({
    streamTitle: 'Testing a new loadout in ranked',
    clipTitle: 'Ranked clutch'
  }), false);

  assert.deepEqual(buildCommunityClipDrafts([
    clip('test-vod-clip', { title: 'Ranked clutch' })
  ], context({ streamTitle: 'Test' })), []);
  assert.deepEqual(buildCommunityClipDrafts([
    clip('placeholder-title', { title: 'Test' })
  ], context()), []);
  assert.deepEqual(buildCommunityClipDrafts([
    clip('wzbot-test-title', { title: 'WzBot CLIP | Test (by saevond)' })
  ], context()), []);
});

test('rejects clips from other channels, non-game categories, malformed ids and invalid durations', () => {
  const invalid = [
    clip('wrong-channel', { broadcaster_id: '2002' }),
    clip('wrong-game', { game_id: '0' }),
    clip('bad-id', { id: 'https://evil.example/clip' }),
    clip('too-short', { duration: 4.9 }),
    clip('too-long', { duration: 60.1 }),
    clip('future', { created_at: new Date(NOW + 10 * 60 * 1000).toISOString() }),
    clip('before-stream', { created_at: new Date(STREAM_START - 30 * 60 * 1000).toISOString() })
  ];
  assert.deepEqual(buildCommunityClipDrafts(invalid, context()), []);
});

test('deduplicates Twitch delivery and persisted drafts, then caps imports per stream', () => {
  const existing = [{ twitchClipId: 'known', streamId: '7777', discoverySource: 'twitch_community_clip' }];
  const batch = [clip('known'), clip('repeat', { view_count: 100 }), clip('repeat', { view_count: 100 }),
    ...Array.from({ length: 28 }, (_, index) => clip(`c${index}`))];
  const drafts = buildCommunityClipDrafts(batch, context({ existingDrafts: existing, maxPerStream: 20 }));
  assert.equal(drafts.length, 19);
  assert.equal(new Set(drafts.map((draft) => draft.twitchClipId)).size, 19);
  assert.equal(drafts.some((draft) => draft.twitchClipId === 'known'), false);
  assert.equal(drafts.some((draft) => draft.twitchClipId === 'repeat'), true);
  assert.equal(drafts.length + existing.length, 20);
  const restarted = buildCommunityClipDrafts(batch, context({ existingDrafts: [...existing, ...drafts] }));
  assert.deepEqual(restarted, []);
});

test('ranks with robust log-view signals plus a 30-minute recency half-life', () => {
  const recent = clip('recent', { view_count: 9, created_at: new Date(NOW).toISOString() });
  const old = clip('old', { view_count: 10_000_000, created_at: new Date(NOW - 4 * 60 * 60 * 1000).toISOString() });
  const drafts = buildCommunityClipDrafts([old, recent], context());
  assert.equal(drafts[0].twitchClipId, 'recent');
  assert.ok(drafts.every((draft) => draft.communityClipScore >= 0 && draft.communityClipScore <= 1));
});

test('retry reuses a persisted gameplay verification without calling Gemini again', async () => {
  const verified = {
    verified: true, totalFrames: 5, activeGameplayFrames: 5, confidence: 0.98,
    evidence: ['frame 1', 'frame 2', 'frame 3', 'frame 4', 'frame 5']
  };
  let calls = 0;
  const result = await reuseOrVerifyGameplay(verified, async () => {
    calls += 1;
    throw new Error('Gemini returned HTTP 503');
  });
  assert.equal(result.reused, true);
  assert.equal(result.gameplay, verified);
  assert.equal(calls, 0);
});

test('retry runs screening when saved verification is missing or below the quality floor', async () => {
  const verified = {
    verified: true, totalFrames: 5, activeGameplayFrames: 4, confidence: 0.91,
    evidence: ['frame 1', 'frame 2', 'frame 3', 'frame 4', 'frame 5']
  };
  let calls = 0;
  const result = await reuseOrVerifyGameplay(null, async () => {
    calls += 1;
    return verified;
  });
  assert.equal(result.reused, false);
  assert.equal(result.gameplay, verified);
  assert.equal(calls, 1);
  await assert.rejects(reuseOrVerifyGameplay(null, async () => ({
    ...verified, confidence: 0.79
  })), /failed visual gameplay verification/);
});

test('retry delays are deterministic, exponential with bounded jitter, and capped at six hours', () => {
  const delays = Array.from({ length: 12 }, (_, index) => clipRetryDelayMs(index + 1, 'draft-a'));
  assert.deepEqual(delays, Array.from({ length: 12 }, (_, index) => clipRetryDelayMs(index + 1, 'draft-a')));
  assert.ok(delays[0] >= 12_000 && delays[0] <= 18_000);
  assert.ok(delays[1] > delays[0]);
  assert.ok(delays.every((delay) => delay > 0 && delay <= 6 * 60 * 60 * 1000));
  assert.equal(isRetryableCommunityClipError(Object.assign(new Error('clip not ready'), { status: 425 })), true);
  assert.equal(isRetryableCommunityClipError(Object.assign(new Error('rate limited'), { status: 429 })), true);
  assert.equal(isRetryableCommunityClipError(Object.assign(new Error('forbidden'), { status: 403 })), false);
  assert.equal(isRetryableCommunityClipError(new Error('gameplay verification failed')), false);
});

test('five-year synthetic stream replay is restart-safe, deduplicated, and bounded', () => {
  let seed = 0x1a2b3c4d;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const day = 24 * 60 * 60 * 1000;
  const firstDay = Date.parse('2021-01-01T00:00:00.000Z');
  const totalDays = 1826;
  let allDrafts = [];
  let streams = 0;
  let testStreamsSkipped = 0;
  let apiEvents = 0;
  let invalid = 0;
  let restarts = 0;
  const clipIds = new Set();

  for (let streamNo = 0, dayNo = 0; dayNo < totalDays; dayNo += 3, streamNo += 1) {
    streams += 1;
    const isTestStream = streamNo % 97 === 0;
    if (isTestStream) testStreamsSkipped += 1;
    const start = firstDay + dayNo * day;
    const now = start + 3 * 60 * 60 * 1000;
    const count = 3 + Math.floor(random() * 10);
    const generated = [];
    for (let index = 0; index < count; index += 1) {
      const id = `s${streamNo}-c${index}`;
      const badRoll = random();
      const overrides = {
        created_at: new Date(start + (5 + random() * 160) * 60 * 1000).toISOString(),
        duration: 5 + Math.round(random() * 550) / 10,
        view_count: Math.floor(Math.exp(random() * 12) - 1),
        title: random() < 0.1 ? 'Test' : `Ranked moment ${index}`
      };
      if (badRoll < 0.025) overrides.broadcaster_id = '9999';
      else if (badRoll < 0.05) overrides.game_id = '0';
      else if (badRoll < 0.075) overrides.duration = 61;
      else if (badRoll < 0.1) overrides.created_at = new Date(now + 10 * 60 * 1000).toISOString();
      if (overrides.broadcaster_id !== '9999' && overrides.game_id !== '0' &&
          overrides.duration <= 60 && Date.parse(overrides.created_at) <= now + 2 * 60 * 1000) apiEvents += 1;
      else invalid += 1;
      generated.push(clip(id, overrides));
      if (random() < 0.12) generated.push(clip(id, overrides)); // redelivery
    }
    if (streamNo % 37 === 0) {
      for (let index = 0; index < 25; index += 1) {
        generated.push(clip(`s${streamNo}-burst${index}`, {
          created_at: new Date(start + 90 * 60 * 1000).toISOString(),
          view_count: Math.floor(random() * 1000)
        }));
      }
    }
    const contextFor = (vodId) => context({
      broadcasterId: '1001', streamId: String(100_000 + streamNo),
      streamStartedAt: new Date(start).toISOString(), gameId: '509658',
      streamTitle: isTestStream ? 'Test' : 'Ranked session',
      now, vodId, existingDrafts: allDrafts,
      idFactory: (() => { let i = 0; return () => `d-${streamNo}-${i++}`; })()
    });
    const firstPass = buildCommunityClipDrafts(generated, contextFor(null));
    if (isTestStream) assert.deepEqual(firstPass, []);
    allDrafts.push(...firstPass);
    restarts += 1;
    // A restart replays duplicates. Archive reconciliation later fills in VOD linkage.
    const relinked = generated.map((item) => ({ ...item,
      video_id: `vod-${streamNo}`,
      vod_offset: Math.max(Number(item.duration), 7200 - Math.floor(Number(item.duration)))
    }));
    const afterRestart = buildCommunityClipDrafts(relinked, contextFor(`vod-${streamNo}`));
    assert.deepEqual(afterRestart, []);
    assert.ok(firstPass.length <= 20);
    for (const draft of firstPass) {
      assert.equal(clipIds.has(draft.twitchClipId), false);
      clipIds.add(draft.twitchClipId);
    }
    // Probe every attempt and a process restart; all scheduled delays remain bounded.
    assert.equal(clipRetryDelayMs(8, `s${streamNo}`), clipRetryDelayMs(8, `s${streamNo}`));
  }

  assert.equal(streams, 609);
  assert.ok(testStreamsSkipped >= 6);
  assert.ok(apiEvents > 3000);
  assert.ok(invalid > 100);
  assert.equal(restarts, streams);
  assert.equal(clipIds.size, allDrafts.length);
  assert.ok(allDrafts.length < apiEvents + 609 * 25);
});
