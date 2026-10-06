const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistAutoAssigner } = require('../src/playlist-auto');
const { simulateFiveYears } = require('../scripts/simulate-five-years');
const { createSeoWorker } = require('../src/seo-worker');

function apiError(status, reason, message = reason) {
  return Object.assign(new Error(message), {
    status,
    response: { status, data: { error: { code: status, message, errors: [{ reason }] } } }
  });
}

function video(id, privacyStatus, title) {
  return { videoId: id, source: { title, tags: [title], privacyStatus } };
}

test('five-year playlist run is deterministic, capacity-bounded, and preserves visibility', () => {
  const result = simulateFiveYears({ startDate: '2026-10-06' });
  const playlist = result.playlistAutopilot;

  assert.equal(result.assumptions.days, 1826);
  assert.equal(result.assumptions.endDate, '2031-10-06');
  assert.equal(playlist.assumptions.historicalMissingMemberships, 3491);
  assert.equal(playlist.sustainable.submittedStreams, 521);
  assert.equal(playlist.sustainable.newPrivateVideos, 2084);
  assert.equal(playlist.threeStreamCeiling.submittedStreams, 782);
  assert.equal(playlist.threeStreamCeiling.newPrivateVideos, 3128);

  for (const scenario of [playlist.sustainable, playlist.threeStreamCeiling, playlist.recoveryStress]) {
    assert.equal(scenario.assignmentCapacity.maximumSlotsPerDay, 60);
    assert.equal(scenario.assignmentCapacity.capInvariant, true);
    assert.equal(scenario.privacyInvariant.preserved, true);
    assert.equal(scenario.privacyInvariant.visibilityMutations, 0);
    assert.equal(scenario.eligibleQueueDrainedByHorizon, true);
    assert.ok(scenario.apiQuota.peakDailyQuotaFits);
    assert.ok(scenario.apiQuota.maxPlaylistQuotaUnitsPerDay < 10000);
    assert.ok(scenario.ownerReviewRequired > 0);
    assert.equal(scenario.allVideosAssigned, false);
  }

  assert.equal(playlist.assumptions.maximumLiveStartsPerWeek, 3);
  assert.match(playlist.assumptions.matchRule, /remain unassigned/);
  assert.match(playlist.assumptions.historicalBacklogNote, /not a current account measurement/);
});

test('playlist recovery stress exercises rate limits, authorization recovery, and duplicate safety', () => {
  const result = simulateFiveYears({ startDate: '2026-10-06' }).playlistAutopilot.recoveryStress;

  assert.ok(result.reliability.transientRetries > 0);
  assert.equal(result.reliability.authorizationFailures, 1);
  assert.equal(result.reliability.reconnects, 1);
  assert.ok(result.idempotentAlreadyPresent > 0);
  assert.equal(result.eligibleQueueDrainedByHorizon, true);
  assert.equal(result.assignmentCapacity.capInvariant, true);
  assert.equal(result.privacyInvariant.preserved, true);
});

test('public backlog batches cannot starve private and unlisted playlist work', async () => {
  const publicCandidates = Array.from({ length: 30 }, (_, index) => ({
    videoId: 'PUB' + String(index).padStart(8, '0'),
    source: { title: 'ARC Raiders extraction', tags: ['ARC Raiders'], privacyStatus: 'public' }
  }));
  const hiddenCandidate = {
    videoId: 'PRV00000001',
    source: { title: 'Naraka Bladepoint duel', tags: ['Naraka Bladepoint'], privacyStatus: 'private' }
  };
  const requested = [];
  const reservations = [];
  const added = [];
  const marked = [];
  const assigner = createPlaylistAutoAssigner({
    env: { YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT: '1' },
    store: {
      listSeoNeedsPlaylist: async (limit, group) => {
        requested.push([limit, group]);
        return group === 'public' ? publicCandidates.slice(0, limit) : [hiddenCandidate];
      },
      markSeoPlaylistResult: async (id, result) => marked.push([id, result]),
      reservePlaylistAutoSlot: async (bucket) => {
        reservations.push(bucket);
        return { allowed: bucket === 'private' };
      }
    },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL-arc', title: 'ARC Raiders', privacyStatus: 'public' },
        { id: 'PL-naraka', title: 'Naraka Bladepoint', privacyStatus: 'private' }
      ],
      addVideoToPlaylist: async (input) => { added.push(input); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });

  const result = await assigner.assignCatalogBacklog();

  assert.deepEqual(requested, [[25, 'public'], [25, 'nonpublic']]);
  assert.equal(result.attempted, 1);
  assert.equal(result.assigned, 1);
  assert.ok(reservations.includes('public'));
  assert.ok(reservations.includes('private'));
  assert.deepEqual(added, [{ playlistId: 'PL-naraka', videoId: 'PRV00000001' }]);
  assert.deepEqual(marked.map(([id]) => id), ['PRV00000001']);
});

test('playlist autopilot stops on OAuth failure and resumes after reauthorization', async () => {
  const candidate = video('abcdefghijk', 'public', 'ARC Raiders extraction');
  let authFailure = true;
  let listCalls = 0;
  let marked = null;
  const store = {
    listSeoNeedsPlaylist: async (_limit, group) => group === 'public' && !marked ? [candidate] : [],
    markSeoPlaylistResult: async (_id, result) => { marked = result; },
    requeueSeoPlaylistAuthorizationFailures: async () => { marked = null; return 1; },
    reservePlaylistAutoSlot: async () => ({ allowed: true })
  };
  const assigner = createPlaylistAutoAssigner({
    store,
    youtube: {
      listOwnedPlaylists: async () => {
        listCalls += 1;
        if (authFailure) throw apiError(401, 'authError', 'invalid_grant');
        return [{ id: 'PL-arc', title: 'ARC Raiders', privacyStatus: 'public' }];
      },
      addVideoToPlaylist: async () => ({ alreadyAdded: false })
    },
    logger: { warn() {} }
  });

  const first = await assigner.assignCatalogBacklog();
  assert.equal(first.attempted, 1);
  assert.equal(marked.state, 'authorization_required');
  const callsAtBlock = listCalls;
  const blocked = await assigner.assignCatalogBacklog();
  assert.equal(blocked.blocked, 'authorization_required');
  assert.equal(listCalls, callsAtBlock);

  authFailure = false;
  await store.requeueSeoPlaylistAuthorizationFailures();
  assigner.resumeAfterYouTubeReconnect();
  const resumed = await assigner.assignCatalogBacklog();
  assert.equal(resumed.assigned, 1);
  assert.equal(marked.state, 'added');
});

test('playlist autopilot retries transient quota errors and holds permanent permission failures for review', async () => {
  let transient = true;
  let permanent = true;
  let inserted = 0;
  const assigner = createPlaylistAutoAssigner({
    store: { reservePlaylistAutoSlot: async () => ({ allowed: true }) },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL-arc', title: 'ARC Raiders', privacyStatus: 'private' }
      ],
      addVideoToPlaylist: async () => {
        if (transient) { transient = false; throw apiError(403, 'rateLimitExceeded'); }
        if (permanent) { permanent = false; throw apiError(403, 'playlistContainsMaximumNumberOfVideos'); }
        inserted += 1;
        return { alreadyAdded: false };
      }
    },
    logger: { warn() {} }
  });

  const retry = await assigner.assign({ id: 'abcdefghijk', title: 'ARC Raiders extraction',
    tags: ['ARC Raiders'], privacyStatus: 'private' });
  assert.equal(retry.state, 'retry');
  assert.ok(retry.at);
  const ownerReview = await assigner.assign({ id: 'abcdefghijk', title: 'ARC Raiders extraction',
    tags: ['ARC Raiders'], privacyStatus: 'private' });
  assert.equal(ownerReview.state, 'manual_review');
  const success = await assigner.assign({ id: 'abcdefghijk', title: 'ARC Raiders extraction',
    tags: ['ARC Raiders'], privacyStatus: 'private' });
  assert.equal(success.state, 'added');
  assert.equal(inserted, 1);
});

test('successful upload assignment is persisted before backlog autopilot can repeat it', async () => {
  const writes = [];
  const worker = createSeoWorker({
    store: {
      upsertSeoVideo: async (id) => writes.push(['upsert', id]),
      markSeoPlaylistResult: async (id, result) => writes.push(['playlist', id, result.state])
    },
    youtube: {
      getVideo: async () => null,
      isConnected: async () => false
    },
    env: {},
    logger: { info() {}, warn() {}, error() {} }
  });

  await worker.registerUpload('abcdefghijk', {
    title: 'ARC Raiders extraction',
    playlistAssignment: { state: 'added', playlistId: 'PL-arc' }
  });
  await worker.registerUpload('lmnopqrstuv', {
    title: 'Naraka Bladepoint duel',
    playlistAssignment: { state: 'daily_limit' }
  });
  await worker.registerUpload('zyxwvutsrqp', {
    title: 'Unrecognized game',
    playlistAssignment: { state: 'disabled' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, [
    ['upsert', 'abcdefghijk'],
    ['playlist', 'abcdefghijk', 'added'],
    ['upsert', 'lmnopqrstuv'],
    ['upsert', 'zyxwvutsrqp']
  ]);
});
