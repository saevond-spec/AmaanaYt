const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPlaylistAutoAssigner, youtubeQuotaDate } = require('../src/playlist-auto');

test('automatic assignment reserves a daily slot and adds only confident matches', async () => {
  const reservations = [];
  const additions = [];
  const assigner = createPlaylistAutoAssigner({
    env: { YOUTUBE_AUTO_PLAYLIST_DAILY_LIMIT: '3' },
    now: () => Date.parse('2026-10-03T12:00:00Z'),
    store: { reservePlaylistAutoSlot: async (...args) => { reservations.push(args); return { allowed: true }; } },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL1', title: 'ARC Raiders', description: '', privacyStatus: 'private' }
      ],
      addVideoToPlaylist: async (args) => { additions.push(args); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });
  const result = await assigner.assign({
    id: 'abcdefghijk', title: 'ARC Raiders clutch extraction',
    tags: ['gaming'], privacyStatus: 'private'
  });
  assert.equal(result.state, 'added');
  assert.equal(result.playlistId, 'PL1');
  assert.equal(additions[0].videoId, 'abcdefghijk');
  assert.deepEqual(reservations[0], ['private', 3, '2026-10-03']);
});

test('daily cap defers matched assignment without playlist writes', async () => {
  let listed = false;
  const assigner = createPlaylistAutoAssigner({
    store: { reservePlaylistAutoSlot: async () => ({ allowed: false }) },
    youtube: {
      listOwnedPlaylists: async () => {
        listed = true;
        return [{ id: 'PL1', title: 'ARC Raiders', description: '', privacyStatus: 'public' }];
      },
      addVideoToPlaylist: async () => ({ alreadyAdded: false })
    }
  });
  assert.equal((await assigner.assign({
    id: 'abcdefghijk', privacyStatus: 'public', title: 'ARC Raiders'
  })).state, 'daily_limit');
  assert.equal(listed, true);
});


test('catalog backlog classifies private and unlisted videos into private playlists only', async () => {
  const reservations = [];
  const additions = [];
  const results = [];
  const candidates = [
    { videoId: 'abcdefghijk', source: { title: 'ARC Raiders clutch extraction',
      description: '', tags: ['ARC Raiders'], privacyStatus: 'private' } },
    { videoId: 'lmnopqrstuv', source: { title: 'Naraka Bladepoint Songbird Arena',
      description: '', tags: ['Naraka Bladepoint'], privacyStatus: 'unlisted' } }
  ];
  const assigner = createPlaylistAutoAssigner({
    store: {
      listSeoNeedsPlaylist: async () => candidates,
      markSeoPlaylistResult: async (id, result) => results.push([id, result]),
      reservePlaylistAutoSlot: async (privacyStatus) => {
        reservations.push(privacyStatus);
        return { allowed: true };
      }
    },
    youtube: {
      listOwnedPlaylists: async () => [
        { id: 'PL-arc-private', title: 'ARC Raiders', privacyStatus: 'private' },
        { id: 'PL-arc-public', title: 'ARC Raiders', privacyStatus: 'public' },
        { id: 'PL-naraka-private', title: 'Naraka Bladepoint', privacyStatus: 'private' },
        { id: 'PL-naraka-public', title: 'Naraka Bladepoint', privacyStatus: 'public' }
      ],
      addVideoToPlaylist: async (input) => { additions.push(input); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });
  const result = await assigner.assignCatalogBacklog();
  assert.deepEqual(reservations, ['private', 'private']);
  assert.equal(result.attempted, 2);
  assert.equal(result.assigned, 2);
  assert.deepEqual(additions, [
    { playlistId: 'PL-arc-private', videoId: 'abcdefghijk' },
    { playlistId: 'PL-naraka-private', videoId: 'lmnopqrstuv' }
  ]);
  assert.ok(results.every(([, value]) => value.privacyStatus === 'private'));
});

test('playlist quota day follows YouTube midnight Pacific reset', () => {
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T06:30:00Z')), '2026-10-02');
  assert.equal(youtubeQuotaDate(Date.parse('2026-10-03T08:00:00Z')), '2026-10-03');
});

test('unmatched metadata is placed in a private review playlist', async () => {
  const created = [];
  const reservations = [];
  const additions = [];
  const assigner = createPlaylistAutoAssigner({
    now: () => Date.parse('2026-10-04T12:00:00Z'),
    store: {
      reservePlaylistAutoSlot: async (...args) => { reservations.push(args); return { allowed: true }; }
    },
    youtube: {
      listOwnedPlaylists: async () => [],
      createPlaylist: async (input) => {
        created.push(input);
        return { id: 'PL-review', title: input.title, description: input.description, privacyStatus: 'private' };
      },
      addVideoToPlaylist: async (input) => { additions.push(input); return { alreadyAdded: false }; }
    },
    logger: { warn() {} }
  });

  const result = await assigner.assign({
    id: 'abcdefghijk', title: 'Unrecognized variety gameplay',
    description: '', tags: [], privacyStatus: 'unlisted'
  });

  assert.equal(result.state, 'fallback_added');
  assert.equal(result.needsReview, true);
  assert.equal(result.matchState, 'no_match');
  assert.equal(result.playlistTitle, 'Needs Playlist Review');
  assert.equal(result.privacyStatus, 'private');
  assert.equal(created.length, 1);
  assert.equal(created[0].privacyStatus, 'private');
  assert.deepEqual(additions, [{ playlistId: 'PL-review', videoId: 'abcdefghijk' }]);
  assert.deepEqual(reservations[0], ['private', 20, '2026-10-04']);
});

test('playlist coverage audit compares every channel upload with all owned playlists', async () => {
  const requeued = [];
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', completed: true }),
    requeueSeoPlaylistResults: async (ids) => { requeued.push(...ids); return ids.length; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' }),
    uploadsPage: async (_uploads, cursor) => cursor
      ? { ids: ['mmmmmmmmmmm'], nextPageToken: null }
      : { ids: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], nextPageToken: 'older' },
    listOwnedPlaylists: async () => [
      { id: 'PL1', title: 'Arc Raiders', privacyStatus: 'public' },
      { id: 'PL2', title: 'Needs Playlist Review', privacyStatus: 'private' }
    ],
    listPlaylistVideoIds: async (playlistId) => playlistId === 'PL1'
      ? ['aaaaaaaaaaa', 'bbbbbbbbbbb'] : ['bbbbbbbbbbb']
  };
  const assigner = createPlaylistAutoAssigner({ store, youtube, now: () => Date.parse('2026-10-04T12:00:00Z') });

  const report = await assigner.reconcilePlaylistCoverage();

  assert.equal(report.catalogCount, 3);
  assert.equal(report.catalogPages, 2);
  assert.equal(report.playlistCount, 2);
  assert.equal(report.coveredCount, 2);
  assert.equal(report.missingCount, 1);
  assert.deepEqual(report.missingVideoIds, ['mmmmmmmmmmm']);
  assert.equal(report.complete, true);
  assert.equal(report.catalogScanComplete, true);
  assert.equal(report.requeuedCount, 1);
  assert.deepEqual(requeued, ['mmmmmmmmmmm']);
});

test('playlist coverage audit does not queue repairs until the catalog scan is complete', async () => {
  let requeueCalls = 0;
  const store = {
    getSeoSyncState: async () => ({ channelId: 'channel-1', completed: false }),
    requeueSeoPlaylistResults: async () => { requeueCalls += 1; return 0; }
  };
  const youtube = {
    ownedChannel: async () => ({ id: 'channel-1', title: 'Owner', uploads: 'uploads-1' }),
    uploadsPage: async () => ({ ids: ['aaaaaaaaaaa'], nextPageToken: null }),
    listOwnedPlaylists: async () => [],
    listPlaylistVideoIds: async () => []
  };
  const assigner = createPlaylistAutoAssigner({ store, youtube });
  const report = await assigner.reconcilePlaylistCoverage();
  assert.equal(report.missingCount, 1);
  assert.equal(report.catalogScanComplete, false);
  assert.equal(report.requeuedCount, 0);
  assert.equal(requeueCalls, 0);
});
